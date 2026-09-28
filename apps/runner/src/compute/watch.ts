import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import type { ComputeExecutor } from "@beam/contracts";
import { reconcileJob } from "@beam/compute";
import { api } from "../../../../convex/_generated/api.js";
import { beamHome } from "../config.ts";
import { LocalExecutor } from "./local.ts";
import { largeOutputPublisher } from "./largeOutput.ts";

export { reconcileJob, uploadBytes } from "@beam/compute";

/** Reconciliation runs independently of watchRuns. No agent or app session owns these jobs. */
export function watchCompute(client: ConvexClient, token: string, executor: ComputeExecutor = new LocalExecutor(join(beamHome(), "compute"))) {
  let stopped = false, working = false;
  const large = largeOutputPublisher(client, token, executor);
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
      await reconcileJob(client, token, executor, job, large ? { large } : {});
    } catch (e) {
      // fetch reports only "fetch failed"; the reason (a reset socket, a timeout) is its cause.
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      console.error("compute reconciliation", (e as Error).message, cause ? `(${cause.code ?? cause.message})` : "");
    }
    finally { working = false; }
  };
  const timer = setInterval(() => void reconcile(), 2000);
  void reconcile();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
