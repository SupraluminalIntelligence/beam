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
  // Buoyancy can shift this device's split, so the even-split Re is information, not a bound.
  expect(check(mana, "laminar")?.status).toBe("info");
  expect(check(mana, "viscosity")?.status).toBe("ok");
});

it("warns when buoyancy could push one channel's flow past laminar, and only when something can shift the split", () => {
  // Four channels at an even-split Re of 1,380, one heated with gravity on: one carrying more than 36 % of the inflow would pass 2,000.
  const four = { ...mana, channels: [7500, 0, 0, 0].map(heatFlux => ({ heatFlux })), cellsAcross: 8, cellsAlong: 40, velocity: 0.03 };
  expect(ParallelChannelsCase.safeParse(four).success).toBe(true);
  expect(check(four, "laminar")).toMatchObject({ status: "warn", value: "Re 1380" });
  expect(check(four, "laminar")?.detail).toContain("more than 36.2 % of the inflow");
  // Without buoyancy strong enough to shift the split, identical channels split evenly and the even-split Re holds: no heating, gravity off, no thermal expansion,
  // or heating so slight that Ri is far below 0.1.
  const faint = { ...four, channels: [1, 0, 0, 0].map(heatFlux => ({ heatFlux })) };
  expect(check(faint, "buoyancy")?.value).toBe("Ri 4.6e-4");
  // Nor does every channel heated alike, or nearly alike, with the flow going up, where buoyancy aids each channel about the same.
  const alike = { ...four, gravity: "upflow" as const, channels: four.channels.map(() => ({ heatFlux: 7500 })) }, nearly = { ...alike, channels: [7500, 7500, 7500, 7499].map(heatFlux => ({ heatFlux })) };
  for (const even of [{ ...four, channels: four.channels.map(() => ({ heatFlux: 0 })) }, { ...four, gravity: "off" as const }, { ...four, beta: 0 }, faint, alike, nearly]) expect(check(even, "laminar")?.status).toBe("ok");
  // Uneven heating flowing up, any heating flowing down, and any heating stacked, even of the top channel alone, can shift it.
  const top = { ...four, channels: [0, 0, 0, 7500].map(heatFlux => ({ heatFlux })) };
  for (const shifted of [{ ...alike, channels: [7500, 7500, 7500, 5000].map(heatFlux => ({ heatFlux })) }, { ...alike, gravity: "downflow" as const }, top]) expect(check(shifted, "laminar")?.status).toBe("warn");
  // The paper's device: all of its inflow through one channel would still be laminar, but a reversed neighbour can push more through it.
  expect(check(mana, "laminar")?.detail).toContain("would give Re 789");
});

it("warns when only an even split keeps a heated wall below boiling and buoyancy could starve it", () => {
  // At 0.2 W/cm² over 120 s an evenly fed wall settles about 37 K above the inlet, 4 K short of boiling; with no flow it would boil after about 40 s.
  const slow = { ...mana, channels: [{ heatFlux: 2000 }, { heatFlux: 0 }], duration: 120 }, both = { ...slow, channels: [{ heatFlux: 2000 }, { heatFlux: 2000 }] };
  const warned = { status: "warn", value: "3.7 K below Tsat if even" }, even = { status: "ok", value: "3.7 K below Tsat" };
  // Stacked, the lower channel draws flow from the upper one whichever is heated, so a heated upper channel can lose flow.
  // A trace of heat in the lower channel changes nothing.
  const onlyTop = { ...slow, channels: [{ heatFlux: 0 }, { heatFlux: 2000 }] }, traceBelow = { ...slow, channels: [{ heatFlux: 1 }, { heatFlux: 2000 }] };
  for (const upper of [both, onlyTop, traceBelow]) expect(check(upper, "single-phase")).toMatchObject(warned);
  expect(check(onlyTop, "single-phase")?.detail).toContain("the lowest channel draws flow from the ones above it");
  // Flowing down, buoyancy opposes the flow in a heated channel.
  expect(check({ ...slow, gravity: "downflow" }, "single-phase")).toMatchObject(warned);
  // Flowing up, it draws flow toward the more strongly heated channel, so only a weaker heated channel can lose flow.
  expect(check({ ...both, gravity: "upflow", channels: [{ heatFlux: 1500 }, { heatFlux: 2000 }] }, "single-phase")).toMatchObject({ status: "warn" });
  // A lone heated channel gains flow stacked lowest or flowing up; heated alike flowing up, the channels keep an even split; with gravity off, or no thermal
  // expansion, buoyancy cannot shift the flow. The steady estimate holds in each. So does it when the channel that can lose flow is heated too weakly to boil
  // within the run with no flow (0.07 W/cm² takes about 5 min).
  // Flowing up, channels heated nearly alike keep an even split too.
  const weakAbove = { ...slow, channels: [{ heatFlux: 2000 }, { heatFlux: 700 }] }, nearly = { ...both, gravity: "upflow" as const, channels: [{ heatFlux: 1999 }, { heatFlux: 2000 }] };
  for (const kept of [slow, weakAbove, nearly, { ...slow, gravity: "upflow" as const }, { ...both, gravity: "upflow" as const }, { ...both, gravity: "off" as const }, { ...both, beta: 0 }]) expect(check(kept, "single-phase")).toMatchObject(even);
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
