import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import { JobSpec, type ComputeExecutor, type ExecutionStatus } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Doc, Id } from "../../../../convex/_generated/dataModel.js";
import { beamHome } from "../config.ts";
import { LocalExecutor } from "./local.ts";
import { collectResults } from "./environment.ts";

export async function uploadBytes(url: string, bytes: Uint8Array): Promise<Id<"_storage">> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([Uint8Array.from(bytes)]), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const data = await response.json() as { storageId: Id<"_storage"> };
  return data.storageId;
}

/** Reconciliation runs independently of watchRuns. No agent or app session owns these jobs. */
export function watchCompute(client: ConvexClient, token: string, executor: ComputeExecutor = new LocalExecutor(join(beamHome(), "compute"))) {
  let stopped = false, working = false;
  const reconcile = async () => {
    if (working || stopped) return;
    working = true;
    try {
      const pending = await client.query(api.compute.pending, { token });
      // Recover running work first; do not claim another local process until it is published.
      const job = pending.find(j => j.state !== "queued") ?? pending[0];
      if (!job) return;
      if (job.backend !== executor.backend) throw new Error(`No executor for ${job.backend}`);
      if (job.state === "queued") {
        if (!(await client.mutation(api.compute.claim, { token, id: job._id }))) return;
        job.state = "preparing";
      }
      await reconcileJob(client, token, executor, job);
    } catch (e) { console.error("compute reconciliation", (e as Error).message); }
    finally { working = false; }
  };
  const timer = setInterval(() => void reconcile(), 2000);
  void reconcile();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

export async function reconcileJob(client: ConvexClient, token: string, executor: ComputeExecutor, job: Doc<"computeJobs">) {
  const id = job._id;
  const spec = JobSpec.parse(job.spec);
  let handle = job.handle;
  if (!handle && job.cancelRequestedAt) await executor.cancelSubmission(id);
  if (!handle) {
    const recovered = await executor.recover(id);
    if (recovered) {
      handle = recovered;
      await client.mutation(api.compute.report, { token, id, state: "running", handle, log: job.log, error: null });
    }
  }
  if (!handle) {
    if (job.cancelRequestedAt) {
      await client.mutation(api.compute.report, { token, id, state: "cancelled", log: job.log, error: "Cancelled before launch" });
      return;
    }
    let inputs;
    try { inputs = await client.query(api.compute.inputs, { token, id }); }
    catch (e) {
      if (/Chat access revoked|Missing input asset|Input has expired/.test((e as Error).message)) {
        await client.mutation(api.compute.report, { token, id, state: "failed", log: job.log, error: (e as Error).message });
      }
      throw e;
    }
    handle = await executor.submit(id, spec, inputs);
    await client.mutation(api.compute.report, { token, id, state: "running", handle, log: job.log, error: null });
  }
  if (job.cancelRequestedAt) await executor.cancel(handle);
  let status;
  try { status = await executor.inspect(handle); }
  catch (e) {
    await client.mutation(api.compute.report, { token, id, state: "failed", log: job.log, error: (e as Error).message }); return;
  }
  if (status.state === "running") {
    if (job.state !== "publishing") await client.mutation(api.compute.report, { token, id, state: "running", handle, log: status.log, error: null });
    return;
  }
  if (status.state !== "succeeded" || job.cancelRequestedAt) {
    await client.mutation(api.compute.report, { token, id, state: job.cancelRequestedAt ? "cancelled" : status.state, log: status.log, error: status.error, exitCode: status.exitCode }); return;
  }
  await client.mutation(api.compute.report, { token, id, state: "publishing", log: status.log, error: null, exitCode: status.exitCode });
  const fail = (error: string) => client.mutation(api.compute.report, { token, id, state: "failed", log: status.log, error, exitCode: status.exitCode });
  let files: { path: string; read: () => Promise<Uint8Array> }[];
  let results: Awaited<ReturnType<typeof collectResults>> | null = null;
  if (spec.kind === "environment") {
    try { results = await collectResults(path => executor.readOutput(handle, path)); }
    catch (e) { await fail(`Results: ${(e as Error).message}`); return; }
    files = results.files.map(f => ({ path: f.path, read: async () => f.bytes }));
  } else files = spec.outputs.map(path => ({ path, read: () => executor.readOutput(handle, path) }));
  for (const file of files) {
    // Already-published outputs are skipped after reconnect; publication is idempotent per path.
    if (!(await stillPublishing(client, token, id, status))) return;
    if (await client.query(api.compute.hasOutput, { token, id, path: file.path })) continue;
    let bytes;
    try { bytes = await file.read(); }
    catch (e) { await fail(`Could not collect ${file.path}: ${(e as Error).message}`); return; }
    const url = await client.mutation(api.compute.outputUploadUrl, { token, id });
    const storageId = await uploadBytes(url, bytes);
    await client.mutation(api.compute.publishOutput, { token, id, path: file.path, storageId });
  }
  if (results) await client.mutation(api.compute.publishResults, { token, id, manifest: results.manifest, unpublished: results.unpublished });
  await client.mutation(api.compute.report, { token, id, state: "succeeded", log: status.log, error: null, exitCode: status.exitCode });
}

async function stillPublishing(client: ConvexClient, token: string, id: Id<"computeJobs">, status: ExecutionStatus) {
  const latest = (await client.query(api.compute.pending, { token })).find(j => j._id === id);
  if (latest && !latest.cancelRequestedAt) return true;
  if (latest) await client.mutation(api.compute.report, { token, id, state: "cancelled", log: status.log, error: "Cancelled during publication" });
  return false;
}
