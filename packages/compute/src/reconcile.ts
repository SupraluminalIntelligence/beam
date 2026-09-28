import type { ConvexClient } from "convex/browser";
import { cloudMachineSeconds, collectResults, ExecutorUnavailable, jobFinished, JobSpec, type ComputeExecutor, type ExecutionHandle, type ExecutionStatus } from "@beam/contracts";
import { api } from "../../../convex/_generated/api.js";
import type { Doc, Id } from "../../../convex/_generated/dataModel.js";

/**
 * One step of a compute job's life, shared by the runner (jobs on the engineer's computer) and the
 * gateway (jobs on cloud machines): launch it once, inspect it, publish its outputs, record the outcome.
 * Every step is safe to repeat after a restart; a launch whose outcome is uncertain is recovered, never
 * replayed.
 */
export async function uploadBytes(url: string, bytes: Uint8Array): Promise<Id<"_storage">> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([Uint8Array.from(bytes)]), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const data = await response.json() as { storageId: Id<"_storage"> };
  return data.storageId;
}

export async function reconcileJob(client: ConvexClient, token: string, executor: ComputeExecutor, job: Doc<"computeJobs">) {
  // A finished cloud job whose machine is not yet confirmed stopped: only the release is left to do.
  const { handle, ended } = jobFinished(job.state) ? { handle: job.handle, ended: true } : await advance(client, token, executor, job);
  if (!ended || !executor.release) return;
  // Beam settles the job's spend only once the machine is confirmed stopped; a failed release is
  // retried on the next pass, and the machine's own lifetime limit bounds it if every retry fails.
  let stoppedAt: number | undefined;
  if (handle) {
    await client.mutation(api.compute.releasing, { token, id: job._id });
    stoppedAt = await executor.release(handle);
  }
  await client.mutation(api.compute.released, { token, id: job._id, ...(stoppedAt ? { stoppedAt } : {}) });
}

async function advance(client: ConvexClient, token: string, executor: ComputeExecutor, job: Doc<"computeJobs">): Promise<{ handle: ExecutionHandle | undefined; ended: boolean }> {
  const id = job._id;
  const spec = JobSpec.parse(job.spec);
  let handle = job.handle;
  const end = async (state: "succeeded" | "failed" | "cancelled", log: string, error: string | null, exitCode?: number | null) => {
    await client.mutation(api.compute.report, { token, id, state, log, error, ...(exitCode !== undefined ? { exitCode } : {}) });
    return { handle, ended: true };
  };
  // An unreachable provider leaves the job as it is, to be tried again; only a known outcome ends it.
  const known = (e: unknown) => { if (e instanceof ExecutorUnavailable) throw e; return (e as Error).message; };
  if (!handle && job.cancelRequestedAt) await executor.cancelSubmission(id);
  if (!handle) {
    const recovered = await executor.recover(id);
    if (recovered) {
      handle = recovered;
      await client.mutation(api.compute.report, { token, id, state: "running", handle, log: job.log, error: null });
    }
  }
  if (!handle) {
    if (job.cancelRequestedAt) return end("cancelled", job.log, "Cancelled before launch");
    let inputs;
    try { inputs = await client.query(api.compute.inputs, { token, id }); }
    catch (e) {
      if (/Chat access revoked|Missing input asset|Input has expired/.test((e as Error).message)) return end("failed", job.log, (e as Error).message);
      throw e;
    }
    // A launch the executor refuses outright (an image it cannot start, an invalid spec) ends the job;
    // an unanswered one is recovered on the next pass.
    if (executor.release) {
      // A cloud launch is recorded before the machine exists. One that could have run to the end of its
      // life while the gateway was away has left no machine to recover, and is not launched again.
      if (job.launchedAt && Date.now() - job.launchedAt > cloudMachineSeconds(spec.timeoutSeconds) * 1000)
        return end("failed", job.log, "The cloud machine for this job stopped before Beam heard from it. It may have run; it was not run again.");
      await client.mutation(api.compute.launching, { token, id });
    }
    try { handle = await executor.submit(id, spec, inputs); }
    catch (e) { return end("failed", job.log, known(e)); }
    await client.mutation(api.compute.report, { token, id, state: "running", handle, log: job.log, error: null });
  }
  const launched = handle;
  if (job.cancelRequestedAt) await executor.cancel(launched);
  // Once publishing, the command's success is on record; a machine that has since stopped only
  // matters if a result still needs reading from it.
  let status: ExecutionStatus = { state: "succeeded", log: job.log, error: null, exitCode: job.exitCode ?? 0 };
  if (job.state !== "publishing") {
    try { status = await executor.inspect(launched); }
    catch (e) { return end("failed", job.log, known(e)); }
  }
  if (status.state === "running") {
    await client.mutation(api.compute.report, { token, id, state: "running", handle: launched, log: status.log, error: null });
    return { handle, ended: false };
  }
  if (status.state !== "succeeded" || job.cancelRequestedAt) return end(job.cancelRequestedAt ? "cancelled" : status.state, status.log, status.error, status.exitCode);
  await client.mutation(api.compute.report, { token, id, state: "publishing", log: status.log, error: null, exitCode: status.exitCode });
  const fail = (error: string) => end("failed", status.log, error, status.exitCode);
  // Publication is idempotent per path, so a pass after a reconnect skips what is already published.
  // A cancel stops it; a failed upload is retried on the next pass rather than failing the job.
  const wanted = async (path: string) => {
    let publishing, published;
    try { publishing = await stillPublishing(client, token, id, status); published = publishing && await client.query(api.compute.hasOutput, { token, id, path }); }
    catch (e) { throw new Retry(e); }
    if (!publishing) throw new Stopped();
    return !published;
  };
  const upload = async (path: string, bytes: Uint8Array) => {
    try {
      const url = await client.mutation(api.compute.outputUploadUrl, { token, id });
      await client.mutation(api.compute.publishOutput, { token, id, path, storageId: await uploadBytes(url, bytes) });
    } catch (e) { throw new Retry(e); }
  };
  const settled = (e: unknown) => { if (e instanceof Retry) throw e.error; return e instanceof Stopped; };
  if (spec.kind === "environment") {
    let results;
    // Each file is published as soon as it is read, so at most one is held in memory.
    const oversize = executor.release ? "not kept, since the cloud machine is released" : "kept on the machine";
    const onFile = async (f: { path: string; bytes: Uint8Array }) => { if (await wanted(f.path)) await upload(f.path, f.bytes); };
    try { results = await collectResults(path => executor.readOutput(launched, path), { onFile, oversize }); }
    catch (e) { if (settled(e)) return { handle, ended: true }; return fail(`Results: ${known(e)}`); }
    await client.mutation(api.compute.publishResults, { token, id, manifest: results.manifest, unpublished: results.unpublished });
  } else {
    for (const path of spec.outputs) {
      try { if (!(await wanted(path))) continue; }
      catch (e) { if (settled(e)) return { handle, ended: true }; throw e; }
      let bytes;
      try { bytes = await executor.readOutput(launched, path); }
      catch (e) { return fail(`Could not collect ${path}: ${known(e)}`); }
      try { await upload(path, bytes); } catch (e) { settled(e); throw e; }
    }
  }
  return end("succeeded", status.log, null, status.exitCode);
}

class Stopped extends Error {}
class Retry { readonly error: unknown; constructor(error: unknown) { this.error = error; } }

async function stillPublishing(client: ConvexClient, token: string, id: Id<"computeJobs">, status: ExecutionStatus) {
  const latest = (await client.query(api.compute.pending, { token })).find(j => j._id === id);
  if (latest && !jobFinished(latest.state) && !latest.cancelRequestedAt) return true;
  if (latest && !jobFinished(latest.state)) await client.mutation(api.compute.report, { token, id, state: "cancelled", log: status.log, error: "Cancelled during publication" });
  return false;
}
