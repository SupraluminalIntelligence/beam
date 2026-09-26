import type { ChannelCase, SimulationReport } from "./simulation.ts";

export type Convergence = "monotonic" | "oscillatory" | "diverging" | "unchanged";
/** One quantity on three meshes, coarse to fine, with its observed order and fine-mesh grid convergence index (relative). */
export type GridEstimate = { quantity: string; unit: string; values: [number, number, number]; convergence: Convergence; order: number | null; extrapolated: number | null; gci: number | null };

/**
 * Three-mesh discretization error estimate (Celik et al. 2008, J. Fluids Eng. 130:078001): observed order from the solution changes,
 * Richardson extrapolation and the fine-mesh GCI with a 1.25 safety factor. Cells and values run coarse to fine.
 */
export function gridConvergence(cells: [number, number, number], values: [number, number, number], dims = 2): Omit<GridEstimate, "quantity" | "unit"> {
  const [h3, h2, h1] = cells.map(n => n ** (-1 / dims)) as [number, number, number], [f3, f2, f1] = values;
  const r21 = h2 / h1, r32 = h3 / h2, e21 = f2 - f1, e32 = f3 - f2;
  const tiny = 1e-12 * Math.max(...values.map(Math.abs), 1e-300);
  if (Math.abs(e21) <= tiny) return { values, convergence: "unchanged", order: null, extrapolated: f1, gci: f1 === 0 ? null : 0 };
  const s = Math.sign(e32 / e21);
  if (s < 0) return { values, convergence: "oscillatory", order: null, extrapolated: null, gci: null };
  // Fixed-point iteration for p when the refinement ratios differ; p <= 0 means the changes grow as the mesh refines.
  let p = Math.log(Math.abs(e32 / e21)) / Math.log(r21);
  for (let k = 0; k < 200 && p > 0 && Number.isFinite(p); k++) {
    const next = (Math.log(Math.abs(e32 / e21)) + Math.log((r21 ** p - s) / (r32 ** p - s))) / Math.log(r21);
    if (Math.abs(next - p) < 1e-10) { p = next; break; }
    p = next;
  }
  if (!(p > 0) || !Number.isFinite(p)) return { values, convergence: "diverging", order: null, extrapolated: null, gci: null };
  const gain = r21 ** p - 1;
  return { values, convergence: "monotonic", order: p, extrapolated: f1 + (f1 - f2) / gain, gci: f1 === 0 ? null : 1.25 * Math.abs((f1 - f2) / f1) / gain };
}

/** A channel setup with the mesh, iteration limit and stated-only fluid data removed; equal keys mean the same physical problem. */
export function channelPhysicsKey(c: ChannelCase) {
  const { nx: _nx, ny: _ny, iterations: _iterations, beta: _beta, boilingPoint: _boilingPoint, ...physics } = c;
  return JSON.stringify(Object.keys(physics).sort().map(k => [k, physics[k as keyof typeof physics]]));
}

const interpolate = (points: [number, number][], x: number) => {
  const k = points.findIndex(([px]) => px >= x);
  if (k < 0) return null;
  if (k === 0) return points[0]![0] === x ? points[0]![1] : null;
  const [x0, y0] = points[k - 1]!, [x1, y1] = points[k]!;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
};

export type ChannelMeshStudy = { cells: [number, number, number]; ratios: [number, number]; estimates: GridEstimate[]; notes: string[] };
/** Mesh study of one heated-channel setup solved on three meshes: outlet temperature rise, developed f·Re and Nu near the outlet. */
export function channelMeshStudy(reports: SimulationReport[]): ChannelMeshStudy | { problem: string } {
  if (reports.length !== 3) return { problem: "A mesh study needs exactly three solves." };
  const runs = [...reports].sort((a, b) => a.cells - b.cells);
  const configs = runs.map(r => r.config);
  if (!configs.every((c): c is ChannelCase => c.geometry === "channel")) return { problem: "Mesh studies cover heated-channel solves only." };
  if (new Set(configs.map(channelPhysicsKey)).size > 1) return { problem: "The three solves differ in more than the mesh. Keep geometry, fluid, flow and temperatures identical." };
  if (new Set(runs.map(r => r.cells)).size < 3) return { problem: "The three solves need three different meshes." };
  const unconverged = runs.find(r => !r.converged);
  if (unconverged) return { problem: `The ${unconverged.cells.toLocaleString("en-US")}-cell solve stopped before meeting its residual targets, so its mesh error can't be separated from iteration error.` };
  const channel = runs.map(r => r.channel);
  if (!channel.every(c => c !== undefined)) return { problem: "Solve all three meshes again with this version of Beam; older reports lack the channel results." };

  const cells = runs.map(r => r.cells) as [number, number, number], ratios: [number, number] = [Math.sqrt(cells[2] / cells[1]), Math.sqrt(cells[1] / cells[0])];
  const notes: string[] = [];
  if (Math.min(...ratios) < 1.1) return { problem: "Refine by at least 1.1 in both directions between meshes; changes smaller than that mostly measure noise." };
  if (Math.min(...ratios) < 1.3) notes.push("Refinement ratios below 1.3 make the observed order sensitive to small changes; Celik et al. recommend at least 1.3.");
  const c = configs[0]!, estimates: GridEstimate[] = [];
  const add = (quantity: string, unit: string, values: number[]) => estimates.push({ quantity, unit, ...gridConvergence(cells, values as [number, number, number]) });
  if (c.thermal && Math.abs(c.wallTemperature - c.inletTemperature) > 1e-9) add("outlet temperature rise", "K", channel.map(r => r.bulkOutletTemperatureK - c.inletTemperature));
  const fRe = channel.map(r => r.fRe);
  if (fRe.every(v => v != null)) add("f·Re, developed", "", fRe); else notes.push("f·Re is left out because the flow is not developed on every mesh.");
  // Nu at the coarse mesh's last evaluated column, which lies inside every finer mesh's range.
  const x = Math.min(...channel.map(r => r.nusselt.at(-1)?.[0] ?? -Infinity)), nu = channel.map(r => interpolate(r.nusselt, x));
  if (Number.isFinite(x) && nu.every(v => v != null)) add(`Nu at ${Number((x * 1000).toPrecision(3))} mm`, "", nu);
  return { cells, ratios, estimates, notes };
}
