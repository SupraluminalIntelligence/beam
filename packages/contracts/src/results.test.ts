import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCounts, collectResults, compareQuantities, FieldPreview, headlineQuantities, MAX_RESULT_FILES, previewByteLengths, resultPaths, ResultsManifest, SeriesData, TableData } from "./results";
import { ExecutorUnavailable } from "./compute";

// Written by environments/base/beam_out from `cantilever.py --nx 10,20,40` in the fea image.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/cantilever/${name}`, import.meta.url), "utf8"));
const manifest = fixture("manifest.json");

describe("what beam_out writes", () => {
  it("parses as a results manifest", () => {
    const m = ResultsManifest.parse(manifest);
    expect(m.quantities.map((q) => q.name)).toEqual(["tip_deflection", "midspan_bending_stress", "degrees_of_freedom", "solve_time"]);
    expect(checkCounts(m)).toEqual({ pass: 4, review: 0, fail: 0, "not-evaluated": 0 });
    expect(headlineQuantities(m).map((q) => q.name)).toEqual(["tip_deflection", "midspan_bending_stress"]);
    expect(m.quantities[0]?.uncertainty?.kind).toBe("gci");
    expect(m.views[0]).toMatchObject({ field: "beam", color: "von_mises", warp: "displacement" });
    expect(resultPaths(m)).toEqual(["series/tip_vs_mesh.json", "fields/beam.vtu", "preview/beam.json", "tables/meshes.json"]);
  });
  it("parses the files the manifest names, with buffers of the declared size", () => {
    const preview = FieldPreview.parse(fixture("preview.json"));
    expect(previewByteLengths(preview)).toEqual(fixture("sizes.json"));
    expect(SeriesData.parse(fixture("series.json")).x).toHaveLength(3);
    expect(TableData.parse(fixture("table.json")).rows).toHaveLength(3);
  });
  it("reads a newer manifest's unknown keys without failing", () => {
    const m = ResultsManifest.parse({ ...manifest, animations: [], quantities: [{ ...manifest.quantities[0], confidence: 0.9 }] });
    expect(m.quantities).toHaveLength(1);
  });
});

describe("what it rejects", () => {
  const bad = (change: object) => ResultsManifest.safeParse({ ...manifest, ...change }).success;
  it("rejects non-finite numbers, unknown statuses and escaping paths", () => {
    expect(bad({ quantities: [{ ...manifest.quantities[0], value: null }] })).toBe(false);
    expect(bad({ checks: [{ ...manifest.checks[0], status: "maybe" }] })).toBe(false);
    expect(bad({ series: [{ ...manifest.series[0], data: "../../etc/passwd" }] })).toBe(false);
    expect(bad({ version: 2 })).toBe(false);
  });
  it("rejects duplicate names, shared files and views of missing results", () => {
    expect(bad({ quantities: [manifest.quantities[0], manifest.quantities[0]] })).toBe(false);
    expect(bad({ tables: [{ ...manifest.tables[0], data: manifest.series[0].data }] })).toBe(false);
    expect(bad({ views: [{ name: "x", field: "beam", color: "temperature" }] })).toBe(false);
    expect(bad({ views: [{ name: "x", plot: "nothing" }] })).toBe(false);
  });
  it("rejects plots and tables whose shapes disagree", () => {
    expect(SeriesData.safeParse({ x: [1, 2], lines: [{ name: "a", values: [1] }] }).success).toBe(false);
    expect(TableData.safeParse({ columns: [{ name: "a" }, { name: "b" }], rows: [[1]] }).success).toBe(false);
  });
});

it("compares versions by name and unit, never converting units", () => {
  const before = { quantities: [
    { name: "stress", label: "stress", value: 212e6, unit: "Pa", headline: true },
    { name: "mass", label: "mass", value: 48.2, unit: "g", headline: false },
    { name: "old", label: "old", value: 1, unit: "1", headline: false },
  ] };
  const after = { quantities: [
    { name: "stress", label: "stress", value: 165e6, unit: "Pa", headline: true },
    { name: "mass", label: "mass", value: 0.0489, unit: "kg", headline: false },
  ] };
  const c = compareQuantities(before, after);
  expect(c.matched).toHaveLength(1);
  expect(c.matched[0]?.relative).toBeCloseTo(-0.2217, 3);
  expect(c.onlyBefore.map((q) => q.name)).toEqual(["mass", "old"]);
  expect(c.onlyAfter.map((q) => `${q.name} ${q.unit}`)).toEqual(["mass kg"]);
});

describe("collecting results", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const manyFiles = { version: 1, files: Array.from({ length: 64 }, (_, n) => ({ path: `f${n}.txt`, label: `f${n}`, kind: "file", bytes: 1 })) };
  it("lists files past the file limit as unpublished instead of failing the job", async () => {
    const tables = Array.from({ length: 20 }, (_, n) => ({ name: `t${n}`, label: `t${n}`, data: `t${n}.json`, rows: 1 }));
    const series = Array.from({ length: 50 }, (_, n) => ({ name: `s${n}`, label: `s${n}`, data: `s${n}.json`, points: 1, x: { label: "x" }, y: { lines: ["a"] } }));
    const manifest = { ...manyFiles, tables, series };
    const published: string[] = [];
    const r = await collectResults(async p => p.endsWith("manifest.json") ? enc(JSON.stringify(manifest)) : enc("x"), { onFile: async f => { published.push(f.path); } });
    expect(published).toHaveLength(MAX_RESULT_FILES);
    expect(r.unpublished).toHaveLength(1 + 64 + 20 + 50 - MAX_RESULT_FILES);
    expect(r.unpublished[0]!.reason).toBe(`past the ${MAX_RESULT_FILES}-file limit`);
    expect(r.files).toEqual([]);
  });
  it("says what happens to a file over the size limit", async () => {
    const read = async (p: string) => { if (p.endsWith("f0.txt")) throw new Error("Job files must be regular files of 20 MB or less"); return enc(p.endsWith("manifest.json") ? JSON.stringify({ version: 1, files: manyFiles.files.slice(0, 1) }) : "x"); };
    expect((await collectResults(read)).unpublished[0]!.reason).toBe("larger than 20 MB; kept on the machine");
    expect((await collectResults(read, { oversize: "not kept" })).unpublished[0]!.reason).toBe("larger than 20 MB; not kept");
  });
  it("passes an unreachable provider through, so the job is retried rather than failed", async () => {
    const read = async (p: string) => { if (p.endsWith("f0.txt")) throw new ExecutorUnavailable("Modal did not answer"); return enc(p.endsWith("manifest.json") ? JSON.stringify({ version: 1, files: manyFiles.files.slice(0, 1) }) : "x"); };
    await expect(collectResults(read)).rejects.toBeInstanceOf(ExecutorUnavailable);
  });
});
