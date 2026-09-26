import { channelEntryLengths, type ChannelCase, type ChannelResults } from "@beam/contracts";

const numbers = (s: string) => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
const clean = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/FoamFile\s*\{[^}]*\}/, "");

/** A polyMesh label list such as owner, ASCII only. */
export function labelList(text: string): number[] {
  const list = clean(text).match(/(\d+)\s*\(([\s\S]*)\)/);
  if (!list) throw new Error("Missing ASCII label list");
  const values = numbers(list[2]!);
  if (values.length !== Number(list[1]) || !values.every(Number.isInteger)) throw new Error("Incomplete label list");
  return values;
}
/** Face range of each patch in a polyMesh boundary file. */
export function patchRanges(text: string): Record<string, { start: number; count: number }> {
  const ranges: Record<string, { start: number; count: number }> = {};
  for (const m of clean(text).matchAll(/(\w+)\s*\{([^{}]*)\}/g)) {
    const count = m[2]!.match(/nFaces\s+(\d+)/)?.[1], start = m[2]!.match(/startFace\s+(\d+)/)?.[1];
    if (count && start) ranges[m[1]!] = { start: Number(start), count: Number(count) };
  }
  return ranges;
}
/** One patch's values from an ASCII scalar field's boundaryField, in patch face order. */
export function patchValues(text: string, patch: string, count: number): number[] {
  const boundary = clean(text).split(/\bboundaryField\b/)[1] ?? "", block = boundary.match(new RegExp(`\\b${patch}\\s*\\{([^{}]*)\\}`))?.[1];
  const listed = block?.match(/value\s+nonuniform\s+List<scalar>\s+(\d+)\s*\(([\s\S]*?)\)\s*;/), uniform = block?.match(/value\s+uniform\s+([^;]+);/);
  const values = listed ? (Number(listed[1]) === count ? numbers(listed[2]!) : []) : uniform ? Array.from({ length: count }, () => Number(uniform[1])) : [];
  if (values.length !== count || !values.every(Number.isFinite)) throw new Error(`Missing ${patch} values`);
  return values;
}

export type ChannelPatches = { inlet: { cells: number[]; flux: number[] }; outlet: { cells: number[]; flux: number[] }; walls: number[] };
export function channelPatches(boundary: string, owner: string, phi: string): ChannelPatches {
  const ranges = patchRanges(boundary), owners = labelList(owner);
  const cells = (name: string) => { const r = ranges[name]; if (!r) throw new Error(`Missing ${name} patch`); return owners.slice(r.start, r.start + r.count); };
  const inlet = cells("inlet"), outlet = cells("outlet");
  return { inlet: { cells: inlet, flux: patchValues(phi, "inlet", inlet.length) }, outlet: { cells: outlet, flux: patchValues(phi, "outlet", outlet.length) }, walls: cells("walls") };
}

/**
 * Engineering quantities for a converged heated channel, from the solver's own face fluxes and cell values.
 * Balances reproduce the discrete fluxes (upwind outlet temperature, half-cell wall and inlet conduction), so they measure conservation.
 * Wall face temperatures are the solver's own: the fixed value, or under a heat flux the cell value plus the imposed gradient times the centre-to-face distance.
 * Local Nusselt numbers use the wall heat flux (imposed, or a second-order gradient at a fixed temperature) and the flow-weighted bulk temperature of each cell column.
 * U is cell-centred (x, y, z) triples; p is kinematic; depth is the one-cell extrusion in metres.
 */
export function channelResults(c: ChannelCase, centres: [number, number, number][], U: number[], p: number[], T: number[], patches: ChannelPatches, depth: number) {
  const dx = c.length / c.nx, dy = c.height / c.ny, dh = 2 * c.height, alpha = c.nu / c.pr, Tin = c.inletTemperature, imposed = c.wallHeatFlux === undefined ? null : c.wallHeatFlux / c.conductivity!;
  const toWall = (cell: number) => Math.min(centres[cell]![1], c.height - centres[cell]![1]), wallT = new Map(patches.walls.map(cell => [cell, imposed === null ? c.wallTemperature : T[cell]! + imposed * toWall(cell)]));
  const grid = Array.from({ length: c.nx }, () => new Array<number>(c.ny).fill(-1));
  centres.forEach(([x, y], cell) => { const i = Math.round(x / dx - 0.5), j = Math.round(y / dy - 0.5); if (grid[i]?.[j] !== -1) throw new Error("Channel cells do not form the declared grid"); grid[i]![j] = cell; });

  const inflow = -patches.inlet.flux.reduce((s, f) => s + f, 0), outflow = patches.outlet.flux.reduce((s, f) => s + f, 0);
  if (!(inflow > 0) || !(outflow > 0)) throw new Error("Channel inlet or outlet flux has the wrong direction");
  // Heat in from walls and by conduction back through the inlet, per unit depth, in K·m²/s; advected rise measured from the inlet temperature.
  const walls = c.thermal ? patches.walls.reduce((s, cell) => s + alpha * (wallT.get(cell)! - T[cell]!) / toWall(cell) * dx, 0) : 0;
  const inletConduction = patches.inlet.cells.reduce((s, cell) => s + alpha * (Tin - T[cell]!) / centres[cell]![0] * dy, 0);
  const advected = patches.outlet.cells.reduce((s, cell, k) => s + patches.outlet.flux[k]! / depth * (T[cell]! - Tin), 0);
  const heated = c.thermal && (imposed !== null || Math.abs(c.wallTemperature - Tin) > 1e-9);

  const nusselt: [number, number][] = [];
  if (heated && c.ny >= 3) for (let i = 0; i < c.nx; i++) {
    const col = grid[i]!, u = col.map(cell => U[3 * cell]!), bulk = col.reduce((s, cell, j) => s + u[j]! * T[cell]!, 0) / u.reduce((s, v) => s + v, 0);
    const bottom = wallT.get(col[0]!)!, top = wallT.get(col[c.ny - 1]!)!, Tw = (bottom + top) / 2;
    const gradient = (w: number, a: number, b: number) => (8 * w - 9 * T[col[a]!]! + T[col[b]!]!) / (3 * dy); // into the fluid, from T at 0, dy/2 and 3dy/2
    const flux = imposed ?? (gradient(bottom, 0, 1) + gradient(top, c.ny - 1, c.ny - 2)) / 2;
    if (Math.abs(Tw - bulk) > 0.01 * Math.abs(Tw - Tin)) nusselt.push([centres[col[0]!]![0], flux * dh / (Tw - bulk)]);
  }

  // Developed pressure gradient: regress column-mean kinematic pressure beyond 1.5 hydrodynamic entry lengths, away from the outlet column.
  const start = 1.5 * channelEntryLengths(c).flow, rows = grid.map(col => [centres[col[0]!]![0], col.reduce((s, cell) => s + p[cell]!, 0) / col.length] as const).filter(([x]) => x >= start && x < c.length - 1.5 * dx);
  let fRe: number | null = null;
  if (rows.length >= 4) {
    const mx = rows.reduce((s, r) => s + r[0], 0) / rows.length, my = rows.reduce((s, r) => s + r[1], 0) / rows.length;
    const slope = rows.reduce((s, r) => s + (r[0] - mx) * (r[1] - my), 0) / rows.reduce((s, r) => s + (r[0] - mx) ** 2, 0);
    fRe = 2 * -slope * dh * dh / (c.velocity * c.nu);
  }
  const results: ChannelResults = {
    bulkOutletTemperatureK: Tin + advected / (outflow / depth),
    ...(c.thermal ? { maxWallTemperatureK: Math.max(...wallT.values()) } : {}),
    energyImbalance: heated && Math.abs(walls) > 0 ? (walls + inletConduction - advected) / walls : null,
    fRe, nusselt,
  };
  return { massImbalance: (outflow - inflow) / inflow, results };
}
