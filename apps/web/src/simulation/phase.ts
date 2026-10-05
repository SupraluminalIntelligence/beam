/**
 * What a simulation's page and card are showing, in one line: the agent's work on the machine (live),
 * a job running (live once Beam reads its solver), checked results, or nothing run yet. The page
 * follows the latest of these, so the same tab moves from a draft's trial runs to a job to its results
 * without a second place to look. A job waiting for approval is said beside whichever it is.
 */
export type PhaseJob = { _id: string; state: string; version: number | null; number?: number; requestedBy?: string; endedAt?: number | undefined; updatedAt?: number | undefined; results: { checks: { pass: number; review: number; fail: number } } | null };
type View = { case: { state: string; updatedAt: number } };
export type PhaseLive = { updatedAt: number; view: View } | null;
export type PhaseJobLive = { jobId: string; updatedAt: number; view: View };
export type Phase =
  | { kind: "machine"; live: boolean; text: string; waiting: string | null }
  | { kind: "job"; live: boolean; text: string; jobId: string; waiting: string | null }
  | { kind: "results"; live: false; text: string; jobId: string; waiting: string | null }
  | { kind: "idle"; live: false; text: string; waiting: string | null };

const ACTIVE = ["queued", "preparing", "running", "publishing"];
/**
 * How long a running case stays live without a new reading. The runner reports at least once a minute
 * while a command runs, so a view this old is no longer being watched (the run ended, the app closed).
 */
export const MACHINE_FRESH_MS = 3 * 60_000;

/** A job as people name it: v2 · job 3, or job 3 for a one-off. */
export const jobName = (j: { version: number | null; number?: number | null }) => [j.version ? `v${j.version}` : null, j.number ? `job ${j.number}` : j.version ? null : "job"].filter(Boolean).join(" · ");
/** Live only while the solver is running: a finished, failed or stopped case is done changing. */
export const isLive = (live: { updatedAt: number; view: View } | null | undefined, now: number) => !!live && live.view.case.state === "running" && now - live.updatedAt < MACHINE_FRESH_MS;

export function phase(sim: { draft?: boolean; version: number; jobs: PhaseJob[] }, live: PhaseLive, now = Date.now(), jobLives: PhaseJobLive[] = []): Phase {
  const name = sim.draft ? "Draft" : `v${sim.version}`;
  const waitingJobs = sim.jobs.filter(j => j.state === "awaiting-approval");
  const waiting = waitingJobs.length === 1 ? `${jobName(waitingJobs[0]!)} needs approval` : waitingJobs.length ? `${waitingJobs.length} jobs need approval` : null;
  const running = sim.jobs.find(j => ACTIVE.includes(j.state));
  if (running) {
    const jobLive = isLive(jobLives.find(l => l.jobId === running._id), now);
    const state = running.state === "queued" ? "queued" : running.state === "preparing" ? "starting" : running.state;
    return { kind: "job", live: running.state !== "queued", jobId: running._id, waiting, text: `${jobName(running)} ${state}${jobLive ? " · live" : ""} · checked when it finishes` };
  }
  const done = sim.jobs.find(j => j.state === "succeeded" && j.results);
  const machineAt = live ? Math.max(live.updatedAt, live.view.case.updatedAt) : 0;
  const fresh = isLive(live, now);
  // Work on the machine is what the page shows when it is newer than the last results, or there are none.
  if (live && (!done || machineAt > (done.endedAt ?? done.updatedAt ?? 0)))
    return { kind: "machine", live: fresh, waiting, text: `${name} · work on the machine${fresh ? " · live" : ""} · nothing here is checked` };
  if (done) {
    const c = done.results!.checks;
    return { kind: "results", live: false, jobId: done._id, waiting, text: `${jobName(done)} · results · ✓ ${c.pass} pass${c.review ? ` · ! ${c.review} to review` : ""}${c.fail ? ` · ✕ ${c.fail} failed` : ""}` };
  }
  return { kind: "idle", live: false, waiting, text: sim.draft ? "Draft · not saved yet" : `v${sim.version} saved · not run yet` };
}
