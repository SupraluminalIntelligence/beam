/**
 * What a simulation's page and card are showing, in one line: the agent's work on the machine (live),
 * a job running, checked results, or nothing run yet. The page follows the latest of these, so the
 * same tab moves from a draft's trial runs to a job to its results without a second place to look.
 */
export type PhaseJob = { _id: string; state: string; version: number | null; endedAt?: number | undefined; updatedAt?: number | undefined; results: { checks: { pass: number; review: number; fail: number } } | null };
export type PhaseLive = { updatedAt: number; view: { case: { state: string; updatedAt: number } } } | null;
export type Phase =
  | { kind: "machine"; live: boolean; text: string }
  | { kind: "job"; live: boolean; text: string; jobId: string }
  | { kind: "results"; live: false; text: string; jobId: string }
  | { kind: "idle"; live: false; text: string };

const ACTIVE = ["queued", "preparing", "running", "publishing"];
/** How long after its last change machine work still counts as what is happening now. */
export const MACHINE_FRESH_MS = 3 * 60_000;

export function phase(sim: { draft?: boolean; version: number; jobs: PhaseJob[] }, live: PhaseLive, now = Date.now()): Phase {
  const name = sim.draft ? "Draft" : `v${sim.version}`;
  const running = sim.jobs.find(j => ACTIVE.includes(j.state));
  if (running) return { kind: "job", live: true, jobId: running._id, text: `v${running.version ?? sim.version} · job ${running.state === "queued" ? "queued" : running.state} · checked when it finishes` };
  const done = sim.jobs.find(j => j.state === "succeeded" && j.results);
  const machineAt = live ? Math.max(live.updatedAt, live.view.case.updatedAt) : 0;
  const fresh = !!live && (live.view.case.state === "running" || now - machineAt < MACHINE_FRESH_MS);
  // Work on the machine is what the page shows when it is newer than the last results, or there are none.
  if (live && (!done || machineAt > (done.endedAt ?? done.updatedAt ?? 0)))
    return { kind: "machine", live: fresh, text: `${name} · work on the machine${fresh ? " · live" : ""} · nothing here is checked` };
  if (done) {
    const c = done.results!.checks;
    return { kind: "results", live: false, jobId: done._id, text: `v${done.version ?? sim.version} · results · ✓ ${c.pass} pass${c.review ? ` · ! ${c.review} to review` : ""}${c.fail ? ` · ✕ ${c.fail} failed` : ""}` };
  }
  return { kind: "idle", live: false, text: sim.draft ? "Draft · not saved yet" : `v${sim.version} saved · not run yet` };
}
