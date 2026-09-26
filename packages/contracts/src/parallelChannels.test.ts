import { expect, it } from "vitest";
import { meshKey, SimulationCase, studySetupChecks } from "./simulation.ts";
import { defaultParallelChannels as mana, ParallelChannelsCase, parallelHeatInput, parallelLayout, parallelSetupChecks, parallelWallEstimate } from "./parallelChannels.ts";

const check = (c: ParallelChannelsCase, id: string) => parallelSetupChecks(c).find(k => k.id === id);

it("accepts the default two-channel device and routes it through the shared case union", () => {
  expect(SimulationCase.parse(mana)).toEqual(mana);
  expect(studySetupChecks(mana)).toEqual(parallelSetupChecks(mana));
  expect(ParallelChannelsCase.safeParse({ ...mana, channels: [{ heatFlux: 1 }] }).success).toBe(false);
  expect(ParallelChannelsCase.safeParse({ ...mana, gravity: "sideways" }).success).toBe(false);
});

it("lays the mesh out in blocks and keeps it within the budget", () => {
  const L = parallelLayout(mana);
  // Manifolds span both channels and the wall: 2 × 70 × (20 + 20 + 20), plus 2 × 20 × 70 in the channels.
  expect(L).toMatchObject({ n: 2, height: 0.015, wallCells: 20, manifoldCells: 70, cells: 11200, channelBottoms: [0, 0.01] });
  expect(L.channelVelocity).toBeCloseTo(0.015);
  expect(ParallelChannelsCase.safeParse({ ...mana, cellsAcross: 30 }).error?.issues[0]?.message).toContain("budget");
  expect(ParallelChannelsCase.safeParse({ ...mana, cellsAcross: 40, cellsAlong: 10 }).error?.issues[0]?.message).toContain("longer than they are high");
  expect(ParallelChannelsCase.safeParse({ ...mana, velocity: 0.1 }).error?.issues[0]?.message).toContain("Reynolds");
});

it("reuses a mesh across heating, fluid and inlet edits but not across geometry or cell counts", () => {
  expect(meshKey({ ...mana, channels: [{ heatFlux: 0 }, { heatFlux: 1e4 }], velocity: 0.005, gravity: "off", duration: 30 })).toBe(meshKey(mana));
  expect(meshKey({ ...mana, wallThickness: 0.004 })).not.toBe(meshKey(mana));
  expect(meshKey({ ...mana, channels: [...mana.channels, { heatFlux: 0 }] })).not.toBe(meshKey(mana));
  expect(meshKey({ ...mana, cellsAlong: 60 })).not.toBe(meshKey(mana));
});

it("estimates heat input and the heated wall's transient rise", () => {
  expect(parallelHeatInput(mana)).toBeCloseTo(1050);
  const e = parallelWallEstimate(mana)!;
  // Five seconds in, the wall is still conduction-limited: it rises as 2q√(αt/π)/k, well short of its steady value.
  expect(e.transient).toBeLessThan(e.steady);
  expect(e.wall - 273.15).toBeGreaterThan(61);
  expect(e.reachesAt(334.15 - 293.15)).toBeGreaterThan(1);
  expect(e.reachesAt(334.15 - 293.15)).toBeLessThan(mana.duration);
});

it("flags buoyancy-driven cells, boiling walls and a run too short to reach steady state for the paper's device", () => {
  expect(check(mana, "buoyancy")).toMatchObject({ status: "info", value: "Ri 42.4" });
  expect(check(mana, "convection-cells")?.status).toBe("warn");
  const boil = check(mana, "single-phase");
  expect(boil?.status).toBe("fail");
  expect(boil?.detail).toContain("61 °C");
  expect(check(mana, "run-length")?.status).toBe("warn");
  expect(check(mana, "laminar")?.status).toBe("ok");
  expect(check(mana, "viscosity")?.status).toBe("ok");
});

it("fails the gravity-off assumption when buoyancy dominates, and has nothing to flag without heat", () => {
  expect(check({ ...mana, gravity: "off" }, "buoyancy")?.status).toBe("fail");
  expect(check({ ...mana, gravity: "off" }, "convection-cells")).toBeUndefined();
  const cold = { ...mana, gravity: "off" as const, channels: [{ heatFlux: 0 }, { heatFlux: 0 }] };
  expect(parallelSetupChecks(cold).filter(k => k.status !== "ok" && k.status !== "info").map(k => k.id)).toEqual(["run-length"]);
  // Vertical channels have no heated floor, so the Rayleigh–Bénard check only applies to a stacked device.
  expect(check({ ...mana, gravity: "upflow" }, "convection-cells")).toBeUndefined();
});
