import { expect, it } from "vitest";
import { defaultParallelChannels as mana } from "@beam/contracts";
import { PARALLEL_DEPTH, parallelHeatLeaving } from "./parallelChannels.ts";

it("counts heat conducted out through outlet faces taking backflow, which the outlet holds at the inlet temperature", () => {
  const Tin = mana.inletTemperature, rhoCp = mana.conductivity * mana.pr / mana.nu, dy = mana.channelHeight / mana.cellsAcross;
  // One inlet cell, and two outlet cells 0.5 mm from the outlet plane at x = 0.21 m: fluid leaves through the first and flows back in through the second.
  const centres: [number, number][] = [[0.0005, 0.001], [0.2095, 0.001], [0.2095, 0.012]];
  const leaving = (T: number[]) => parallelHeatLeaving(mana, centres, T, { cells: [0], flux: [-1e-8] }, { cells: [1, 2], flux: [2e-8, -1e-8] });
  const cold = leaving([Tin, Tin + 10, Tin]), warm = leaving([Tin, Tin + 10, Tin + 10]);
  expect(cold.heatW).toBeCloseTo(2e-8 * 10 / PARALLEL_DEPTH * rhoCp, 6);
  // Fluid flowing back in at T_in carries no heat above it, but the warm cell beside that face conducts k·ΔT/d out through it.
  expect(warm.heatW - cold.heatW).toBeCloseTo(mana.conductivity * 10 / 0.0005 * dy, 9);
  // The outlet temperature averages only the face where fluid leaves.
  expect(warm.outletTemperatureK).toBeCloseTo(Tin + 10, 9);
  // Heat conducts back out through the inlet the same way.
  expect(leaving([Tin + 1, Tin + 10, Tin]).heatW - cold.heatW).toBeCloseTo(mana.conductivity / 0.0005 * dy, 9);
});
