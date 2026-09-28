import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arch } from "node:os";
import { RECIPE_OUTPUTS, ResultsManifest, simulationOutputs, studySetupChecks, type ResultCheck, type ResultQuantity, type ResultSeries, type SimulationJob, type SimulationReport } from "@beam/contracts";

/** A plot's points as the results views read them, thinned to at most `max` per line. */
function thin<T>(rows: T[], max = 2000): T[] {
  const stride = Math.max(1, Math.ceil(rows.length / max));
  return rows.filter((_, i) => i % stride === 0 || i === rows.length - 1);
}
const SETUP_STATUS = { ok: "pass", warn: "review", fail: "fail", unknown: "not-evaluated", info: "not-evaluated" } as const;
const fmt = (v: number, digits = 3) => Number(v.toPrecision(digits)).toString();

/**
 * The job's results in Beam's standard layout, from the study's report: numbers with units, the checks
 * that say how far to trust them, plots, and the study's own files (which the Simulation pane reads)
 * under beam/out/recipe. Written after the study succeeds; a failed study writes nothing.
 */
export async function writeStudyResults(sim: SimulationJob, dir: string, report: SimulationReport, started: number) {
  const out = join(dir, "beam/out"), c = sim.config;
  const quantities: ResultQuantity[] = [], checks: ResultCheck[] = [], series: ResultSeries[] = [];
  const q = (name: string, label: string, value: number | null | undefined, unit: string, headline = false) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) quantities.push({ name, label, value, unit, headline });
  };
  const plot = async (s: Omit<ResultSeries, "data" | "points" | "kind"> & { x: { label: string; unit: string } }, x: number[], lines: { name: string; values: number[] }[]) => {
    const data = `series/${s.name}.json`;
    await mkdir(join(out, "series"), { recursive: true });
    await writeFile(join(out, data), JSON.stringify({ x, lines }));
    series.push({ ...s, kind: "line", data, points: x.length });
  };

  // Setup: the study's own modelling checks, as the Simulation pane shows them.
  for (const s of studySetupChecks(c) ?? []) checks.push({ id: `setup-${s.id}`, label: s.label, status: SETUP_STATUS[s.status], stage: "setup", value: s.value, detail: s.detail });

  // Mesh.
  q("cells", "cells", report.cells, "1", sim.stage === "mesh");
  q("max_non_orthogonality", "max non-orthogonality", report.maxNonOrthogonality, "deg");
  q("max_skewness", "max skewness", report.maxSkewness, "1");
  checks.push({ id: "mesh-quality", label: "mesh quality", status: report.meshOk ? "pass" : "fail", stage: "mesh", criterion: "checkMesh reports Mesh OK",
    value: [report.maxNonOrthogonality !== null ? `non-orthogonality ${fmt(report.maxNonOrthogonality)}°` : null, report.maxSkewness !== null ? `skewness ${fmt(report.maxSkewness)}` : null].filter(Boolean).join(", ") || undefined,
    ...(report.domain3d ? { detail: report.domain3d.geometryChecks } : {}) });

  if (sim.stage === "solve") {
    const transient = report.physicalTime !== undefined;
    q("iterations", transient ? "time steps" : "iterations", report.iterations, "1");
    q("physical_time", "simulated time", report.physicalTime, "s");
    q("max_courant", "max Courant number", report.maxCourant, "1");
    q("pressure_drop", "pressure drop, inlet to outlet", report.pressureDropPa, "Pa", c.geometry === "channel" || c.geometry === "parallel-channels");
    q("outlet_temperature", "outlet temperature, cells next to the outlet", report.outletTemperatureK, "K");
    q("mass_imbalance", "mass imbalance, outlet vs inlet", report.massImbalance, "1");
    checks.push(transient
      ? { id: "convergence", label: "steady-state convergence", status: "not-evaluated", stage: "solve", detail: "A transient run reaching its end time is not steady-state convergence; judge it from the time history." }
      : { id: "convergence", label: "solver convergence", status: report.converged ? "pass" : "review", stage: "solve", criterion: "residuals below the SIMPLE targets",
          value: report.converged ? `met in ${report.iterations} iterations` : `not met in ${report.iterations} iterations` });
    if (report.massImbalance !== null) {
      const m = Math.abs(report.massImbalance);
      checks.push({ id: "mass-balance", label: "mass balance", status: m < 1e-3 ? "pass" : m < 1e-2 ? "review" : "fail", stage: "post", value: `${fmt(m * 100, 2)}%`, criterion: "|outflow − inflow| / inflow < 0.1%" });
    }
    checks.push({ id: "mesh-sensitivity", label: "mesh sensitivity", status: "not-evaluated", stage: "mesh", detail: "One mesh was run. Refine it (or run the study's mesh study) to see how much the numbers move." });

    const ch = report.channel;
    if (ch) {
      q("bulk_outlet_temperature", "bulk outlet temperature (flow-weighted)", ch.bulkOutletTemperatureK, "K", c.geometry === "channel" && c.thermal);
      q("max_wall_temperature", "max wall temperature", ch.maxWallTemperatureK, "K");
      q("f_re", "f·Re, developed flow", ch.fRe, "1", true);
      if (ch.fRe !== null) quantities.at(-1)!.reference = { value: 96, source: "fully developed laminar flow between parallel plates" };
      if (ch.energyImbalance !== null) {
        const e = Math.abs(ch.energyImbalance);
        checks.push({ id: "energy-balance", label: "energy balance", status: e < 0.01 ? "pass" : e < 0.05 ? "review" : "fail", stage: "post", value: `${fmt(e * 100, 2)}%`, criterion: "wall heat in vs enthalpy rise < 1%" });
      }
      if (ch.nusselt.length) await plot({ name: "nusselt", label: "local Nusselt number on 2H", x: { label: "distance from inlet", unit: "m" }, y: { unit: "1", scale: "linear", lines: ["Nu"] } },
        ch.nusselt.map(p => p[0]), [{ name: "Nu", values: ch.nusselt.map(p => p[1]) }]);
    }
    const par = report.parallel;
    if (par) {
      q("inflow", "inflow", par.inflow, "m^3/s");
      par.flows.forEach((f, i) => q(`flow_${i + 1}`, `flow through channel ${i + 1}`, f, "m^3/s", i === 0));
      if (par.history.length) await plot({ name: "channel_flows", label: "flow per channel", x: { label: "time", unit: "s" }, y: { unit: "m^3/s", scale: "linear", lines: par.flows.map((_, i) => `channel ${i + 1}`) } },
        par.history.map(h => h.time), par.flows.map((_, i) => ({ name: `channel ${i + 1}`, values: par.history.map(h => h.flows[i]!) })));
    }
    const forces = report.domain3d?.forces;
    if (forces) {
      q("drag_force", "drag force (x)", forces.forceN[0], "N", true);
      q("lift_force", "lift force (z)", forces.forceN[2], "N");
      q("cd", "drag coefficient Cd", forces.cd, "1", true);
      q("cl", "lift coefficient Cl", forces.cl, "1");
      if (forces.history.length) await plot({ name: "force_coefficients", label: "force coefficients", x: { label: "time", unit: "s" }, y: { unit: "1", scale: "linear", lines: ["Cd", "Cl"] } },
        forces.history.map(h => h[0]), [{ name: "Cd", values: forces.history.map(h => h[1]) }, { name: "Cl", values: forces.history.map(h => h[2]) }]);
    }
    if (report.residuals.length) {
      const fields = [...new Set(report.residuals.map(r => r.field))].slice(0, 8);
      const iterations = [...new Set(report.residuals.map(r => r.iteration))].sort((a, b) => a - b), kept = thin(iterations);
      // The first solve of a field in an iteration carries its initial residual; later correctors start lower.
      const by = new Map<string, number>();
      for (const r of report.residuals) { const key = `${r.field}\u0000${r.iteration}`; if (!by.has(key)) by.set(key, r.initial); }
      // A field not solved at every kept iteration has no line of its own rather than gaps.
      const lines = fields.map(f => ({ name: f, values: kept.map(i => Math.max(by.get(`${f}\u0000${i}`) ?? Number.NaN, 1e-30)) })).filter(l => l.values.every(Number.isFinite));
      if (lines.length) await plot({ name: "residuals", label: "initial residuals", x: { label: transient ? "time step" : "iteration", unit: "1" }, y: { unit: "1", scale: "log", lines: lines.map(l => l.name) } }, kept, lines);
    }
  }

  // The study's own files, which the Simulation pane and its tools read.
  const files = [];
  for (const name of simulationOutputs(sim.stage, c)) {
    const from = join(dir, name), to = join(out, "recipe", name);
    const size = await stat(from).then(s => s.size, () => null);
    if (size === null) continue;
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    files.push({ path: `recipe/${name}`, label: name, kind: "file" as const, bytes: size });
  }
  const manifest = ResultsManifest.parse({
    version: 1,
    provenance: { environment: process.env["BEAM_ENVIRONMENT"] ?? "cfd", image: report.image, arch: arch(), cpus: Number(process.env["BEAM_CORES"]) || null, command: `beam-recipe (${c.geometry} ${sim.stage})`, wallSeconds: (Date.now() - started) / 1000, writtenAt: new Date().toISOString() },
    quantities, checks, series, files,
  });
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}
export { RECIPE_OUTPUTS };
