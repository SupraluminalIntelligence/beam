import { LIVE_LIMITS, LiveView, thinIndices, type LiveCase, type LiveSeries } from "@beam/contracts";
import { parseCheckMesh, parseFoamLog, type DatTable, type FoamLog } from "./foam.ts";

/** What the runner read from one case. */
export type CaseReading = {
  case: LiveCase;
  cases: LiveCase[];
  /** The solver's log, as text or as read so far by a foamLogReader. */
  log: string | FoamLog | null;
  /** Function-object output by object name (forceCoeffs, yPlus, …), each joined across restarts. */
  objects: Record<string, DatTable>;
  checkMesh: string | null;
  command: { text: string; startedAt: number } | null;
};

/** Steady solvers count iterations; the rest advance in physical time. */
const steady = (solver: string | null) => !!solver && /simple|potentialfoam/i.test(solver);

function series(name: string, label: string, x: { label: string; unit: string }, y: LiveSeries["y"], xs: number[], lines: { name: string; values: (number | null)[] }[]): LiveSeries | null {
  const kept = lines.filter(l => l.values.some(v => v !== null && (y.scale === "linear" || v > 0))).slice(0, LIVE_LIMITS.lines);
  if (!xs.length || !kept.length) return null;
  const keep = thinIndices(xs.length);
  const clean = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || (y.scale === "log" && v <= 0) ? null : v);
  return { name, label, x, y, xs: keep.map(i => xs[i]!), lines: kept.map(l => ({ name: l.name, values: keep.map(i => clean(l.values[i])) })) };
}

/** The last value that is there. */
const lastOf = (values: (number | null)[]) => { for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!; return null; };
const column = (t: DatTable, name: string) => { const i = t.columns.indexOf(name); return i < 0 ? null : t.rows.map(r => (typeof r[i] === "number" ? r[i] as number : null)); };

/** The live view of one case: residuals, force coefficients, y+, checkMesh and the latest numbers. */
export function buildLiveView(r: CaseReading): LiveView {
  const log = typeof r.log === "string" ? parseFoamLog(r.log) : r.log;
  // The log names its application (simpleFoam), where its file may be named for a launcher (log.mpirun).
  const solver = log?.solver ?? r.case.solver ?? null;
  const x = steady(solver) ? { label: "iteration", unit: "" } : { label: "time", unit: "s" };
  const out: LiveSeries[] = [], quantities: LiveView["quantities"] = [];
  const q = (name: string, label: string, value: number | null | undefined, unit = "1") => { if (value !== null && value !== undefined && Number.isFinite(value)) quantities.push({ name, label, value, unit }); };

  if (log && log.times.length) {
    const s = series("residuals", "Initial residuals", x, { unit: "1", scale: "log" }, log.times, [...log.residuals].map(([name, values]) => ({ name, values })));
    if (s) out.push(s);
    if (log.courant.some(c => c !== null)) { const c = series("courant", "Max Courant number", x, { unit: "1", scale: "linear" }, log.times, [{ name: "max Co", values: log.courant }]); if (c) out.push(c); }
    q(steady(solver) ? "iteration" : "time", steady(solver) ? "iteration" : "simulated time", log.times.at(-1), steady(solver) ? "1" : "s");
    q("continuity", "continuity error, sum local", log.continuity);
    q("courant", "max Courant number", lastOf(log.courant));
  }

  // Force coefficients: each on a plot of its own, since their scales differ by orders of magnitude.
  const coeffs = r.objects["forceCoeffs"];
  if (coeffs?.rows.length) {
    const xs = coeffs.rows.map(row => row[0] as number);
    for (const [name, label] of [["Cd", "Drag coefficient Cd"], ["Cl", "Lift coefficient Cl"], ["CmPitch", "Pitching moment coefficient"]] as const) {
      const values = column(coeffs, name);
      if (!values) continue;
      const s = series(`coeff-${name}`, label, x, { unit: "1", scale: "linear" }, xs, [{ name, values }]);
      if (s) { out.push(s); q(name, label, lastOf(values)); }
    }
  }

  // y+ on each wall patch: average and max over time, for at most three patches.
  const yplus = r.objects["yPlus"];
  if (yplus?.rows.length) {
    const patchCol = yplus.columns.indexOf("patch"), avg = yplus.columns.indexOf("average"), max = yplus.columns.indexOf("max");
    const patches = [...new Set(yplus.rows.map(row => String(row[patchCol] ?? "")))].filter(Boolean).slice(0, 3);
    for (const patch of patches) {
      const rows = yplus.rows.filter(row => String(row[patchCol]) === patch);
      const pick = (i: number) => rows.map(row => (typeof row[i] === "number" ? row[i] as number : null));
      const s = series(`yplus-${patch}`.slice(0, 80), `y+ on ${patch}`, x, { unit: "1", scale: "linear" }, rows.map(row => row[0] as number), [{ name: "average", values: pick(avg) }, { name: "max", values: pick(max) }]);
      if (s) { out.push(s); q(`yplus-${patch}`, `y+ on ${patch}, average`, lastOf(pick(avg))); q(`yplus-max-${patch}`, `y+ on ${patch}, max`, lastOf(pick(max))); }
    }
  }

  const mesh = r.checkMesh ? parseCheckMesh(r.checkMesh) : null;
  if (mesh?.cells !== null && mesh?.cells !== undefined) q("cells", "cells", mesh.cells);

  return LiveView.parse({
    version: 1,
    case: { ...r.case, solver },
    cases: r.cases.slice(0, LIVE_LIMITS.cases),
    quantities: quantities.slice(0, LIVE_LIMITS.quantities),
    mesh,
    series: out.slice(0, LIVE_LIMITS.series),
    command: r.command,
  });
}
