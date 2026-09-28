import { expect, it } from "vitest";
import { EnvironmentJobSpec } from "./compute";
import { FilesSetup, Parameters, parametersFile, setupChanges, sweepSetups } from "./simulations";

const IMAGE = "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:" + "a".repeat(64);
const base = FilesSetup.parse({
  kind: "files", environment: { name: "fea", image: IMAGE }, command: "python solve.py",
  files: [{ path: "solve.py", assetId: "a1" }, { path: "bracket.geo", assetId: "a2" }],
  parameters: [{ name: "fillet_radius", value: 2, unit: "mm" }, { name: "load", value: 1200, unit: "N" }, { name: "model", value: "linear", unit: "" }],
});

it("declares parameters with units and keeps beam/ for Beam", () => {
  expect(base.timeoutSeconds).toBe(3600);
  expect(Parameters.safeParse([{ name: "a", value: 1 }, { name: "a", value: 2 }]).success).toBe(false);
  expect(Parameters.safeParse([{ name: "fillet radius", value: 1 }]).success).toBe(false);
  expect(Parameters.safeParse([{ name: "x", value: Number.NaN }]).success).toBe(false);
  expect(FilesSetup.safeParse({ ...base, files: [{ path: "beam/out/x", assetId: "a" }] }).success).toBe(false);
  expect(FilesSetup.safeParse({ ...base, files: [{ path: "a.py", assetId: "1" }, { path: "a.py", assetId: "2" }] }).success).toBe(false);
});

it("writes the parameters file beam_out.parameters() reads", () => {
  expect(JSON.parse(parametersFile(base.parameters))).toEqual({ fillet_radius: { value: 2, unit: "mm" }, load: { value: 1200, unit: "N" }, model: { value: "linear", unit: "" } });
});

it("says what changed between versions", () => {
  const after = FilesSetup.parse({ ...base, files: [{ path: "solve.py", assetId: "a9" }, { path: "post.py", assetId: "a3" }], parameters: [{ name: "fillet_radius", value: 4, unit: "mm" }, { name: "load", value: 1200, unit: "N" }, { name: "mesh", value: 0.5, unit: "mm" }] });
  expect(setupChanges(base, after)).toEqual(["fillet_radius: 2 mm → 4 mm", "+ mesh = 0.5 mm", "− model", "~ solve.py", "+ post.py", "− bracket.geo"]);
  expect(setupChanges(base, base)).toEqual([]);
});

it("sweeps one parameter and leaves everything else alone", () => {
  const runs = sweepSetups(base, "fillet_radius", [3, 4, 5]);
  expect(runs.map((s) => s.parameters[0]?.value)).toEqual([3, 4, 5]);
  expect(runs.every((s) => s.files === base.files || JSON.stringify(s.files) === JSON.stringify(base.files))).toBe(true);
  expect(runs.map((s) => setupChanges(base, s))).toEqual([["fillet_radius: 2 mm → 3 mm"], ["fillet_radius: 2 mm → 4 mm"], ["fillet_radius: 2 mm → 5 mm"]]);
  expect(() => sweepSetups(base, "thickness", [1])).toThrow("no parameter thickness");
  expect(() => sweepSetups(base, "load", [])).toThrow("1 to 32");
});

it("links a job to its version and refuses an input where the parameters go", () => {
  const job = { version: 1, kind: "environment", title: "Bracket · v2", environment: { name: "fea", image: IMAGE }, command: "python solve.py", inputs: [{ assetId: "a1", path: "solve.py" }], machine: "local", timeoutSeconds: 60, parameters: [{ name: "fillet_radius", value: 4, unit: "mm" }], simulation: { caseId: "sim1", version: 2 } };
  expect(EnvironmentJobSpec.parse(job).simulation).toEqual({ caseId: "sim1", version: 2 });
  expect(EnvironmentJobSpec.safeParse({ ...job, inputs: [{ assetId: "a1", path: "beam/parameters.json" }] }).success).toBe(false);
});
