import type { ConvexClient } from "convex/browser";
import type { ComputeExecutor } from "@beam/contracts";
import { reconcileJob } from "@beam/compute";
import { api } from "../../../convex/_generated/api.js";

/**
 * Drives every cloud job in Convex through the shared reconcile step, several at once, one pass per
 * job at a time. Everything lives in Convex and the provider, so a restarted gateway picks up where the
 * last one stopped: running jobs are recovered by job ID, never launched twice.
 */
export function watchCloudJobs(client: ConvexClient, token: string, executor: ComputeExecutor, { intervalMs = 2000, concurrency = 16 } = {}) {
  const inFlight = new Set<string>();
  let stopped = false;
  const pass = async (job: Awaited<ReturnType<typeof pending>>[number]) => {
    try {
      if (job.state === "queued") {
        if (!(await client.mutation(api.compute.claim, { token, id: job._id }))) return;
        job.state = "preparing";
      }
      await reconcileJob(client, token, executor, job);
    } catch (e) { console.error(`job ${job._id}:`, (e as Error).message); }
    finally { inFlight.delete(job._id); }
  };
  const pending = () => client.query(api.compute.pending, { token });
  const tick = async () => {
    if (stopped) return;
    let jobs;
    try { jobs = await pending(); }
    catch (e) { console.error("pending cloud jobs:", (e as Error).message); return; }
    // Jobs already on a machine come first, so new claims never starve collection.
    for (const job of jobs.sort((a, b) => Number(a.state === "queued") - Number(b.state === "queued"))) {
      if (inFlight.has(job._id) || job.backend !== executor.backend) continue;
      if (job.state === "queued" && inFlight.size >= concurrency) break;
      inFlight.add(job._id);
      void pass(job);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { tick, inFlight, stop: () => { stopped = true; clearInterval(timer); } };
}
