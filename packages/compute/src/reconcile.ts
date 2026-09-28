import type { ConvexClient } from "convex/browser";
import { collectResults, JobSpec, type ComputeExecutor, type ExecutionHandle, type ExecutionStatus } from "@beam/contracts";
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
  const { handle, ended } = await advance(client, token, executor, job);
  // The outcome is recorded, so the machine has nothing left to hold. A release lost to a crash is
  // bounded by the machine's own lifetime limit.
  if (ended && handle && executor.release) {
    try { await executor.release(handle); }
    catch (e) { console.error("compute release", (e as Error).message); }
  }
}

async function advance(client: ConvexClient, token: string, executor: ComputeExecutor, job: Doc<"computeJobs">): Promise<{ handle: ExecutionHandle | undefined; ended: boolean }> {
  const id = job._id;
  const spec = JobSpec.parse(job.spec);
  let handle = job.handle;
  const end = async (state: "succeeded" | "failed" | "cancelled", log: string, error: string | null, exitCode?: number | null) => {
    await client.mutation(api.compute.report, { token, id, state, log, error, ...(exitCode !== undefined ? { exitCode } : {}) });
    return { handle, ended: true };
  };
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
    handle = await executor.submit(id, spec, inputs);
    await client.mutation(api.compute.report, { token, id, state: "running", handle, log: job.log, error: null });
  }
  const launched = handle;
  if (job.cancelRequestedAt) await executor.cancel(launched);
  let status;
  try { status = await executor.inspect(launched); }
  catch (e) { return end("failed", job.log, (e as Error).message); }
  if (status.state === "running") {
    if (job.state !== "publishing") await client.mutation(api.compute.report, { token, id, state: "running", handle: launched, log: status.log, error: null });
    return { handle, ended: false };
  }
  if (status.state !== "succeeded" || job.cancelRequestedAt) return end(job.cancelRequestedAt ? "cancelled" : status.state, status.log, status.error, status.exitCode);
  await client.mutation(api.compute.report, { token, id, state: "publishing", log: status.log, error: null, exitCode: status.exitCode });
  const fail = (error: string) => end("failed", status.log, error, status.exitCode);
  let files: { path: string; read: () => Promise<Uint8Array> }[];
  let results: Awaited<ReturnType<typeof collectResults>> | null = null;
  if (spec.kind === "environment") {
    try { results = await collectResults(path => executor.readOutput(launched, path)); }
    catch (e) { return fail(`Results: ${(e as Error).message}`); }
    files = results.files.map(f => ({ path: f.path, read: async () => f.bytes }));
  } else files = spec.outputs.map(path => ({ path, read: () => executor.readOutput(launched, path) }));
  for (const file of files) {
    // Already-published outputs are skipped after reconnect; publication is idempotent per path.
    if (!(await stillPublishing(client, token, id, status))) return { handle, ended: true };
    if (await client.query(api.compute.hasOutput, { token, id, path: file.path })) continue;
    let bytes;
    try { bytes = await file.read(); }
    catch (e) { return fail(`Could not collect ${file.path}: ${(e as Error).message}`); }
    const url = await client.mutation(api.compute.outputUploadUrl, { token, id });
    const storageId = await uploadBytes(url, bytes);
    await client.mutation(api.compute.publishOutput, { token, id, path: file.path, storageId });
  }
  if (results) await client.mutation(api.compute.publishResults, { token, id, manifest: results.manifest, unpublished: results.unpublished });
  return end("succeeded", status.log, null, status.exitCode);
}

async function stillPublishing(client: ConvexClient, token: string, id: Id<"computeJobs">, status: ExecutionStatus) {
  const latest = (await client.query(api.compute.pending, { token })).find(j => j._id === id);
  if (latest && !latest.cancelRequestedAt) return true;
  if (latest) await client.mutation(api.compute.report, { token, id, state: "cancelled", log: status.log, error: "Cancelled during publication" });
  return false;
}
