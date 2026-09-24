import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SimulationProgress, simulationPhase, type ProgressJob } from "./SimulationProgress";

const job: ProgressJob = { state: "running", createdAt: 1, startedAt: 2, simulation: { stage: "solve", revision: 3 } };
const render = (changes: Partial<ProgressJob> = {}) => renderToStaticMarkup(<SimulationProgress job={{ ...job, ...changes }} onOpen={() => {}} />);

it("shows solving and meshing as distinct live phases", () => {
  expect(render()).toContain("Simulation running");
  expect(render()).toContain('sim-progress live');
  expect(render()).toContain("View job log");
  expect(render({ simulation: { stage: "mesh", revision: 2 } })).toContain("Generating and checking mesh");
});
it("distinguishes preparation and publication from solver execution", () => {
  expect(simulationPhase({ ...job, state: "preparing" })).toBe("Preparing solver");
  expect(render({ state: "publishing" })).toContain("Computation finished · saving output files.");
});
it("does not animate approval, queued, offline, or cancelling jobs as active computation", () => {
  for (const change of [{ state: "queued" as const }, { state: "awaiting-approval" as const }, { runnerOnline: false }, { cancelRequestedAt: 3 }]) {
    expect(render(change)).not.toContain('sim-progress live');
  }
  expect(render({ state: "awaiting-approval" })).toContain("Review job");
  expect(render({ runnerOnline: false })).toContain("Runner disconnected");
  expect(render({ cancelRequestedAt: 3 })).toContain("Stopping solver");
});
it("removes the loader for every terminal state", () => {
  for (const state of ["succeeded", "failed", "cancelled"] as const) expect(render({ state })).toBe("");
});
