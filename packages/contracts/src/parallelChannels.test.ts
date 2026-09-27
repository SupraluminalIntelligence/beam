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

it("warns when buoyancy could push one channel's flow past laminar, even with an even split well inside it", () => {
  // Four channels at an even-split Re of 1,380: one carrying more than 36 % of the inflow would pass 2,000.
  const four = { ...mana, channels: [0, 0, 0, 0].map(heatFlux => ({ heatFlux })), cellsAcross: 8, cellsAlong: 40, velocity: 0.03 };
  expect(ParallelChannelsCase.safeParse(four).success).toBe(true);
  expect(check(four, "laminar")).toMatchObject({ status: "warn", value: "Re 1380" });
  expect(check(four, "laminar")?.detail).toContain("more than 36.2 % of the inflow");
  // The paper's device stays laminar even with all of its inflow through one channel.
  expect(check(mana, "laminar")?.detail).toContain("Re would be 789");
});

it("warns when only an even split keeps a heated wall below boiling and buoyancy could starve it", () => {
  // At 0.2 W/cm² over 120 s an evenly fed wall settles about 37 K above the inlet, 4 K short of boiling; with no flow it would boil after about 40 s.
  const slow = { ...mana, channels: [{ heatFlux: 2000 }, { heatFlux: 0 }], duration: 120 };
  expect(check(slow, "single-phase")).toMatchObject({ status: "warn", value: "3.7 K below Tsat if even" });
  expect(check(slow, "single-phase")?.detail).toContain("buoyancy can starve a heated channel");
  // With gravity off identical channels split evenly, so the steady estimate holds.
  expect(check({ ...slow, gravity: "off" }, "single-phase")).toMatchObject({ status: "ok", value: "3.7 K below Tsat" });
});

it("fails the Boussinesq approximation once the density would change by 10 % or more", () => {
  // Over 30 s the heated wall is estimated about 130 K above the inlet: βΔT ≈ 0.24.
  expect(check({ ...mana, duration: 30 }, "buoyancy")).toMatchObject({ status: "fail", value: "βΔT 0.238" });
});

it("bases the convection-roll check on the difference across a channel, not the fluid's warming along it", () => {
  // A 0.5 mm channel run to steady state: the wall ends about 33 K above the inlet, but only 13 K of that is across the channel, wall to core.
  // Taken over the full height with the whole 33 K, Ra would be about 4,900 and trip the check.
  const thin = { ...mana, channelHeight: 0.0005, cellsAcross: 4, duration: 60 };
  expect(parallelWallEstimate(thin)!.across).toBeCloseTo(13.2, 1);
  expect(parallelWallEstimate(thin)!.wall - thin.inletTemperature).toBeGreaterThan(30);
  expect(check(thin, "convection-cells")?.status).toBe("ok");
  expect(check(mana, "convection-cells")?.value).toBe("Ra 1.0e6");
});

it("fails the gravity-off assumption when buoyancy dominates, and has nothing to flag without heat", () => {
  expect(check({ ...mana, gravity: "off" }, "buoyancy")?.status).toBe("fail");
  expect(check({ ...mana, gravity: "off" }, "convection-cells")).toBeUndefined();
  const cold = { ...mana, gravity: "off" as const, channels: [{ heatFlux: 0 }, { heatFlux: 0 }] };
  expect(parallelSetupChecks(cold).filter(k => k.status !== "ok" && k.status !== "info").map(k => k.id)).toEqual(["run-length"]);
  // Liquid already at its boiling point boils without any heating.
  expect(check({ ...cold, inletTemperature: 335 }, "single-phase")).toMatchObject({ status: "fail", value: "inlet at or above Tsat" });
  expect(check({ ...mana, inletTemperature: 335 }, "single-phase")?.status).toBe("fail");
  // Vertical channels have no heated floor, so the Rayleigh–Bénard check only applies to a stacked device.
  expect(check({ ...mana, gravity: "upflow" }, "convection-cells")).toBeUndefined();
});
