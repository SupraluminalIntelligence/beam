import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLiveView, datReader, foamLogReader, joinRestarts, parseCheckMesh, parseDat, parseFoamLog } from "./index.ts";

// Trimmed from a real run: the NACA 0012 job's coarse mesh (simpleFoam with Spalart-Allmaras, 4 MPI
// processes, restarted at 600, 1100 and 1600 iterations), on the dev deployment.
const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

describe("a solver log", () => {
  const log = parseFoamLog(fixture("simpleFoam.txt"));
  it("reads the application and every step's initial residuals", () => {
    expect(log.solver).toBe("simpleFoam");
    expect(log.times.slice(0, 3)).toEqual([1, 2, 3]);
    expect(log.times.at(-1)).toBe(2100);
    expect([...log.residuals.keys()]).toEqual(["Ux", "Uy", "p", "nuTilda"]);
    expect(log.residuals.get("Ux")![4]).toBeCloseTo(0.0115624286341, 12);
    expect(log.residuals.get("p")!.every(v => v === null || v > 0)).toBe(true);
    expect(log.ended).toBe(true);
    expect(log.fatal).toBeNull();
    expect(log.continuity).not.toBeNull();
  });
  it("leaves a half-written last line for the next read, and records a fatal error", () => {
    const partial = parseFoamLog("Exec   : pimpleFoam\nTime = 0.1\n\nsmoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-5, No Iterations 2\nCourant Number mean: 0.1 max: 0.8\nTime = 0.2\n\nsmoothSolver:  Solving for Ux, Initial resid");
    expect(partial.solver).toBe("pimpleFoam");
    expect(partial.times).toEqual([0.1, 0.2]);
    expect(partial.residuals.get("Ux")).toEqual([0.5, null]);
    expect(partial.courant).toEqual([0.8, null]);
    expect(parseFoamLog("Time = 1\n--> FOAM FATAL ERROR: Maximum number of iterations exceeded\n").fatal).toMatch(/FOAM FATAL ERROR/);
  });
  it("takes a field's first solve in a step, not its later correctors", () => {
    const log2 = parseFoamLog("Time = 1\nGAMG:  Solving for p, Initial residual = 1, Final residual = 0.1, No Iterations 5\nGAMG:  Solving for p, Initial residual = 0.01, Final residual = 1e-4, No Iterations 5\n");
    expect(log2.residuals.get("p")).toEqual([1]);
  });
  it("reads a growing log piece by piece to the same result, and carries on through a restart", () => {
    const text = fixture("simpleFoam.txt"), cut = text.lastIndexOf("\n", text.length / 2) + 1;
    const reader = foamLogReader();
    reader.push(text.slice(0, cut));
    expect(reader.log.ended).toBe(false);
    expect(reader.push(text.slice(cut))).toEqual(log);
    reader.push("Exec   : simpleFoam -parallel\nTime = 2101\n\nGAMG:  Solving for p, Initial residual = 0.001, Final residual = 1e-5, No Iterations 3\n");
    expect(reader.log.ended).toBe(false);
    expect(reader.log.times.at(-1)).toBe(2101);
    expect(reader.log.times[0]).toBe(1);
  });
});

describe("function-object output", () => {
  const part = (start: number) => ({ start, table: parseDat(fixture(`forceCoeffs/${start}/coefficient.dat`)) });
  it("reads the columns from the last comment line", () => {
    const t = part(0).table;
    expect(t.columns.slice(0, 5)).toEqual(["Time", "Cd", "Cd(f)", "Cd(r)", "Cl"]);
    expect(t.rows[0]![0]).toBe(1);
    expect(t.rows[0]![1]).toBeCloseTo(0.1236007577936, 12);
  });
  it("joins restarts in time order, a later one replacing the earlier from where it starts", () => {
    const joined = joinRestarts([part(600), part(0)]);
    const times = joined.rows.map(r => r[0] as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    expect(times.filter(t => t >= 600)[0]).toBe(part(600).table.rows[0]![0]);
  });
  it("reads a growing .dat file piece by piece, keeping its columns", () => {
    const text = fixture("forceCoeffs/0/coefficient.dat"), cut = text.lastIndexOf("\n", text.length / 2) + 1;
    const reader = datReader();
    reader.push(text.slice(0, cut));
    expect(reader.push(text.slice(cut))).toEqual(parseDat(text));
  });
  it("keeps a patch column as text", () => {
    const t = parseDat(fixture("yPlus/0/yPlus.dat"));
    expect(t.columns).toEqual(["Time", "patch", "min", "max", "average"]);
    expect(t.rows[0]).toEqual([600, "airfoil", expect.any(Number), expect.any(Number), expect.any(Number)]);
  });
});

it("reads checkMesh's numbers and its failed or flagged checks", () => {
  const m = parseCheckMesh(fixture("checkMesh.txt"));
  expect(m.cells).toBe(33792);
  expect(m.maxNonOrthogonality).toBeCloseTo(44.751660954, 6);
  expect(m.maxSkewness).toBeCloseTo(1.25610607256, 8);
  expect(m.maxAspectRatio).toBeCloseTo(41768.206827, 4);
  expect(m.failed[0]).toMatch(/High aspect ratio cells found/);
});

it("builds a live view with residuals, each coefficient on its own plot, y+ and the latest numbers", () => {
  const view = buildLiveView({
    case: { path: "run/coarse", solver: null, state: "done", updatedAt: 1 },
    cases: [{ path: "run/coarse", solver: null, state: "done", updatedAt: 1 }],
    log: fixture("simpleFoam.txt"),
    objects: { forceCoeffs: joinRestarts([0, 600].map(start => ({ start, table: parseDat(fixture(`forceCoeffs/${start}/coefficient.dat`)) }))), yPlus: parseDat(fixture("yPlus/0/yPlus.dat")) },
    checkMesh: fixture("checkMesh.txt"),
    command: null,
  });
  expect(view.case.solver).toBe("simpleFoam");
  expect(view.series.map(s => s.name)).toEqual(["residuals", "coeff-Cd", "coeff-Cl", "coeff-CmPitch", "yplus-airfoil"]);
  expect(view.series[0]!.x).toEqual({ label: "iteration", unit: "" });
  expect(view.series[0]!.y.scale).toBe("log");
  expect(view.series.every(s => s.xs.length <= 1500)).toBe(true);
  expect(view.quantities.map(q => q.name)).toEqual(expect.arrayContaining(["iteration", "Cd", "Cl", "yplus-airfoil", "cells"]));
  expect(view.mesh?.cells).toBe(33792);
  expect(JSON.stringify(view).length).toBeLessThan(256 * 1024);
});
