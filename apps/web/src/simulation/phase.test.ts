import { expect, it } from "vitest";
import { MACHINE_FRESH_MS, phase, type PhaseJob } from "./phase";

const NOW = 1_000_000_000;
const job = (over: Partial<PhaseJob>): PhaseJob => ({ _id: "j1", state: "succeeded", version: 1, endedAt: NOW - 10 * 60_000, results: { checks: { pass: 4, review: 1, fail: 0 } }, ...over });
const live = (at: number, state = "running") => ({ updatedAt: at, view: { case: { state, updatedAt: at } } });

it("shows a draft's work on the machine, live while it changes", () => {
  expect(phase({ draft: true, version: 0, jobs: [] }, live(NOW - 2000), NOW)).toEqual({ kind: "machine", live: true, text: "Draft · work on the machine · live · nothing here is checked" });
  expect(phase({ draft: true, version: 0, jobs: [] }, live(NOW - MACHINE_FRESH_MS - 1, "stopped"), NOW)).toMatchObject({ kind: "machine", live: false, text: "Draft · work on the machine · nothing here is checked" });
  expect(phase({ draft: true, version: 0, jobs: [] }, null, NOW)).toEqual({ kind: "idle", live: false, text: "Draft · not saved yet" });
});

it("stops being live as soon as the solver finishes or fails, or once nobody is reading the machine", () => {
  for (const state of ["done", "failed", "stopped"])
    expect(phase({ draft: true, version: 0, jobs: [] }, live(NOW - 2000, state), NOW)).toMatchObject({ kind: "machine", live: false, text: "Draft · work on the machine · nothing here is checked" });
  expect(phase({ version: 1, jobs: [] }, live(NOW - MACHINE_FRESH_MS - 1), NOW)).toMatchObject({ kind: "machine", live: false });
});

it("moves to a running job, then to its results, until newer machine work starts", () => {
  expect(phase({ version: 1, jobs: [job({ state: "running", results: null })] }, live(NOW - 60 * 60_000, "done"), NOW)).toMatchObject({ kind: "job", live: true, jobId: "j1" });
  expect(phase({ version: 1, jobs: [job({})] }, live(NOW - 60 * 60_000, "done"), NOW)).toEqual({ kind: "results", live: false, jobId: "j1", text: "v1 results · ✓ 4 pass · ! 1 to review".replace("v1 results", "v1 · results") });
  // The agent goes back to the machine to prepare v2: that is now the latest thing.
  expect(phase({ version: 1, jobs: [job({})] }, live(NOW - 1000), NOW)).toMatchObject({ kind: "machine", live: true, text: "v1 · work on the machine · live · nothing here is checked" });
});

it("says a saved simulation has not run yet", () => {
  expect(phase({ version: 2, jobs: [job({ state: "failed", results: null })] }, null, NOW)).toEqual({ kind: "idle", live: false, text: "v2 saved · not run yet" });
});
