import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import { JobSpec, type ComputeExecutor } from "@beam/contracts";
import { reconcileJob } from "@beam/compute";
import { api } from "../../../../convex/_generated/api.js";
import { beamHome } from "../config.ts";
import { LocalExecutor } from "./local.ts";
import { largeOutputPublisher } from "./largeOutput.ts";
import { readMachine, type Memory } from "./observe.ts";
import type { Doc } from "../../../../convex/_generated/dataModel.js";

export { reconcileJob, uploadBytes } from "@beam/compute";

const READ_EVERY_MS = 4000;

/**
 * Reads a running local job's working directory as the machine is read while an agent works (what its
 * solver writes: logs, function objects, checkMesh) and reports it when it changes, so its simulation
 * shows the job live. A failed reading is logged once and tried again; it never holds up the job.
 */
export function jobWatcher(client: ConvexClient, token: string, home: string, log: (message: string) => void = console.error) {
  const jobs = new Map<string, { memory: Memory; last: string; at: number; quiet: boolean }>();
  return async (job: Doc<"computeJobs">, now = Date.now()) => {
    const spec = JobSpec.parse(job.spec);
    if (spec.kind !== "environment" || !["preparing", "running", "publishing"].includes(job.state)) { jobs.delete(job._id); return; }
    // What was read from jobs that ended while the runner was away is let go.
    for (const [id, other] of jobs) if (id !== job._id && now - other.at > 10 * 60_000) jobs.delete(id);
    const seen = jobs.get(job._id) ?? { memory: new Map(), last: "", at: 0, quiet: false };
    jobs.set(job._id, seen);
    if (now - seen.at < READ_EVERY_MS) return;
    seen.at = now;
    try {
      // While it runs, its command is running; once it is publishing, the case says how it ended.
      const command = job.state === "publishing" ? null : { text: spec.command, startedAt: job.startedAt ?? job.createdAt };
      const reading = await readMachine(join(home, job._id, "work"), command, now, seen.memory);
      if (!reading || reading.fingerprint === seen.last) return;
      await client.mutation(api.live.reportJob, { token, id: job._id, view: reading.view });
      seen.last = reading.fingerprint;
      seen.quiet = false;
    } catch (e) {
      if (!seen.quiet) log(`job view ${job._id}: ${(e as Error).message}`);
      seen.quiet = true;
    }
  };
}

/** Reconciliation runs independently of watchRuns. No agent or app session owns these jobs. */
export function watchCompute(client: ConvexClient, token: string, executor: ComputeExecutor = new LocalExecutor(join(beamHome(), "compute"))) {
  let stopped = false, working = false;
  const large = largeOutputPublisher(client, token, executor);
  const watchJob = executor instanceof LocalExecutor ? jobWatcher(client, token, executor.home) : null;
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
      if (watchJob) await watchJob(job);
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
