import { expect, it } from "vitest";
import { defaultChannel, type SimulationReport } from "./simulation.ts";
import { channelMeshStudy, channelPhysicsKey, gridConvergence } from "./meshStudy.ts";

// φ(h) = φ0 + C·h^p on 2-D meshes, with unequal refinement ratios.
const exact = (cells: number[], phi0: number, c: number, p: number) => cells.map(n => phi0 + c * n ** (-p / 2)) as [number, number, number];

it("recovers the order and extrapolated value of a smooth error, with unequal refinement ratios", () => {
  const cells: [number, number, number] = [800, 1800, 5000], g = gridConvergence(cells, exact(cells, 7.54, 40, 2));
  expect(g.convergence).toBe("monotonic");
  expect(g.order).toBeCloseTo(2, 6);
  expect(g.extrapolated).toBeCloseTo(7.54, 6);
  const [,, f1] = g.values, r21 = Math.sqrt(5000 / 1800);
  expect(g.gci).toBeCloseTo(1.25 * Math.abs(f1 - g.values[1]) / f1 / (r21 ** 2 - 1), 10);
  expect(gridConvergence(cells, exact(cells, 96, -300, 1)).order).toBeCloseTo(1, 6);
  // Ratios 1.3 then 2: the ratio of changes is below 1, which an order estimate from logs alone would read as diverging.
  const uneven: [number, number, number] = [200, 338, 1352], g2 = gridConvergence(uneven, exact(uneven, 7.54, 400, 2));
  expect(g2.convergence).toBe("monotonic");expect(g2.order).toBeCloseTo(2, 6);expect(g2.extrapolated).toBeCloseTo(7.54, 6);
});
it("names oscillating, growing and unchanged results instead of inventing an order", () => {
  expect(gridConvergence([800, 1800, 4050], [7.9, 7.7, 7.8]).convergence).toBe("oscillatory");
  expect(gridConvergence([800, 1800, 4050], [7.9, 7.89, 7.7])).toMatchObject({ convergence: "diverging", gci: null });
  expect(gridConvergence([800, 1800, 4050], [7.6, 7.6, 7.6])).toMatchObject({ convergence: "unchanged", gci: 0, extrapolated: 7.6 });
  // The finer pair agrees but the coarse mesh does not: no order, and no zero error band.
  expect(gridConvergence([800, 1800, 4050], [7.9, 7.6, 7.6])).toMatchObject({ convergence: "plateau", order: null, gci: null, extrapolated: null });
  expect(gridConvergence([800, 1800, 4050], [7.9, 7.6 + 1e-10, 7.6])).toMatchObject({ convergence: "plateau", gci: null });
});

const channel = { ...defaultChannel, height: .001, velocity: .2, nu: 3.8e-7, pr: 9.8, density: 1510 };
const report = (nx: number, ny: number, nu: number, fRe: number | null, rise: number, over: Partial<SimulationReport> = {}): SimulationReport => ({
  version: 1, stage: "solve", config: { ...channel, nx, ny }, image: "", cells: nx * ny, meshOk: true, maxNonOrthogonality: 0, maxSkewness: 0, iterations: 200, converged: true, residuals: [],
  massImbalance: 0, pressureDropPa: 1, outletTemperatureK: 0, thermalBalance: "not-evaluated", meshSensitivity: "not-studied",
  channel: { bulkOutletTemperatureK: channel.inletTemperature + rise, energyImbalance: 0, fRe, nusselt: Array.from({ length: nx }, (_, i) => [(i + .5) * channel.length / nx, nu] as [number, number]) },
  ...over,
});

it("estimates each channel quantity at a station every mesh resolves", () => {
  const study = channelMeshStudy([report(90, 27, 7.78, 95.9, 18.2), report(40, 12, 8.1, 94, 17.5), report(60, 18, 7.9, 95.2, 18)]);
  if ("problem" in study) throw new Error(study.problem);
  expect(study.cells).toEqual([480, 1080, 2430]);
  expect(study.ratios[0]).toBeCloseTo(1.5, 10);
  expect(study.estimates.map(e => e.quantity)).toEqual(["outlet temperature rise", "f·Re, developed", "Nu at 198 mm"]);
  expect(study.estimates.every(e => e.convergence === "monotonic" && e.gci! > 0)).toBe(true);
});
it("refuses studies that are not one setup on three converged, distinct meshes", () => {
  const ok = [report(40, 12, 8.1, 94, 17.5), report(60, 18, 7.9, 95.2, 18), report(90, 27, 7.78, 95.9, 18.2)];
  expect(channelMeshStudy(ok.slice(0, 2))).toHaveProperty("problem");
  expect(channelMeshStudy([ok[0]!, ok[1]!, { ...ok[2]!, config: { ...channel, nx: 90, ny: 27, velocity: .1 } }])).toHaveProperty("problem", expect.stringContaining("differ in more than the mesh"));
  expect(channelMeshStudy([ok[0]!, ok[1]!, { ...ok[2]!, converged: false }])).toHaveProperty("problem", expect.stringContaining("2,430-cell"));
  expect(channelMeshStudy([ok[0]!, ok[1]!, report(64, 18, 7.8, 95.5, 18.1)])).toHaveProperty("problem", expect.stringContaining("nx and ny"));
  // Total cells refine by about 1.5, but the wall-normal ny never changes.
  expect(channelMeshStudy([report(20, 10, 8.1, 94, 17.5), report(45, 10, 7.9, 95.2, 18), report(101, 10, 7.78, 95.9, 18.2)])).toHaveProperty("problem", expect.stringContaining("nx and ny"));
  const adiabatic = (nx: number, ny: number) => { const r = report(nx, ny, 0, null, 0); return { ...r, config: { ...channel, nx, ny, thermal: false }, channel: { ...r.channel!, nusselt: [] } }; };
  expect(channelMeshStudy([adiabatic(40, 12), adiabatic(60, 18), adiabatic(90, 27)])).toHaveProperty("problem", expect.stringContaining("None of"));
  expect(channelMeshStudy([ok[0]!, ok[1]!, { ...ok[2]!, channel: undefined }])).toHaveProperty("problem", expect.stringContaining("older reports"));
  expect(channelPhysicsKey({ ...channel, nx: 10, iterations: 3000, beta: 1e-3 })).toBe(channelPhysicsKey(channel));
  // A wall heat flux heats the fluid whatever the unused wallTemperature says.
  const flux = (r: SimulationReport): SimulationReport => ({ ...r, config: { ...r.config as typeof channel, wallTemperature: channel.inletTemperature, wallHeatFlux: 5000, conductivity: .069 } });
  const study = channelMeshStudy(ok.map(flux));
  expect("problem" in study ? [] : study.estimates.map(e => e.quantity)).toContain("outlet temperature rise");
  // The solver ignores a flux case's wall temperature and a fixed-temperature case's conductivity, so they may differ between meshes.
  const placeholder = (r: SimulationReport, wallTemperature: number): SimulationReport => ({ ...r, config: { ...r.config as typeof channel, wallTemperature } });
  expect(channelMeshStudy([placeholder(flux(ok[0]!), 300), placeholder(flux(ok[1]!), 350), flux(ok[2]!)])).not.toHaveProperty("problem");
  expect(channelPhysicsKey({ ...channel, conductivity: .069 })).toBe(channelPhysicsKey(channel));
  expect(channelPhysicsKey({ ...channel, wallTemperature: 350 })).not.toBe(channelPhysicsKey(channel));
  expect(channelPhysicsKey({ ...channel, thermal: false, wallTemperature: 350 })).toBe(channelPhysicsKey({ ...channel, thermal: false }));
  const plateau = channelMeshStudy([report(40, 12, 8.1, 94, 17.5), report(60, 18, 7.9, 95.2, 18), report(90, 27, 7.9, 95.9, 18.2)]);
  expect("problem" in plateau ? null : plateau.estimates.find(e => e.quantity.startsWith("Nu"))?.convergence).toBe("plateau");
  expect("problem" in plateau ? [] : plateau.notes).toContain("For Nu at 198 mm, the two finer meshes agree but the coarse one differs, so three meshes give no order or error band. Add a finer mesh.");
});
