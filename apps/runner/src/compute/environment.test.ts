import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ENVIRONMENTS, type EnvironmentJobSpec } from "@beam/contracts";
import { closeLocalMachine, collectResults, environmentProcess, execOnLocalMachine, machineContainer, openLocalMachine } from "./environment.ts";
import { LocalExecutor } from "./local.ts";

// A real manifest written by beam_out in the fea image (packages/contracts/src/fixtures/cantilever).
const fixtures = new URL("../../../../packages/contracts/src/fixtures/cantilever/", import.meta.url);
const text = (name: string) => readFile(new URL(name, fixtures), "utf8");
async function results(overrides: Record<string, Uint8Array | Error> = {}) {
  const sizes = JSON.parse(await text("sizes.json")) as Record<string, number>;
  const files: Record<string, Uint8Array | Error> = {
    "beam/out/manifest.json": new TextEncoder().encode(await text("manifest.json")),
    "beam/out/series/tip_vs_mesh.json": new TextEncoder().encode(await text("series.json")),
    "beam/out/tables/meshes.json": new TextEncoder().encode(await text("table.json")),
    "beam/out/preview/beam.json": new TextEncoder().encode(await text("preview.json")),
    "beam/out/fields/beam.vtu": new Uint8Array(100),
    ...Object.fromEntries(Object.entries(sizes).map(([p, n]) => [`beam/out/${p}`, new Uint8Array(n)])),
    ...overrides,
  };
  return async (path: string) => {
    const f = files[path];
    if (f instanceof Error) throw f;
    if (!f) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    return f;
  };
}

describe("collecting results from beam/out", () => {
  it("publishes the manifest and exactly the files it names, preview buffers included", async () => {
    const r = await collectResults(await results());
    expect(r.manifest?.checks).toHaveLength(4);
    expect(r.files.map(f => f.path).sort()).toEqual([
      "beam/out/fields/beam.vtu", "beam/out/manifest.json", "beam/out/preview/beam.displacement.f32", "beam/out/preview/beam.indices.u32",
      "beam/out/preview/beam.json", "beam/out/preview/beam.positions.f32", "beam/out/preview/beam.von_mises.f32",
      "beam/out/series/tip_vs_mesh.json", "beam/out/tables/meshes.json",
    ]);
    expect(r.unpublished).toEqual([]);
  });
  it("keeps files over the size limit on the machine and lists them", async () => {
    const r = await collectResults(await results({ "beam/out/fields/beam.vtu": new Error("Job files must be regular files of 20 MB or less") }));
    expect(r.unpublished).toEqual([{ path: "beam/out/fields/beam.vtu", reason: "larger than 20 MB; kept on the machine" }]);
    expect(r.files.some(f => f.path.endsWith(".vtu"))).toBe(false);
  });
  it("fails on a truncated preview buffer, a missing named file or an invalid manifest", async () => {
    await expect(collectResults(await results({ "beam/out/preview/beam.positions.f32": new Uint8Array(12) }))).rejects.toThrow("its preview says 8088");
    await expect(collectResults(await results({ "beam/out/series/tip_vs_mesh.json": new Error("ENOENT: no such file") }))).rejects.toThrow("could not be read");
    await expect(collectResults(await results({ "beam/out/manifest.json": new TextEncoder().encode('{"version":2}') }))).rejects.toThrow("manifest.json is invalid");
  });
  it("treats a job that wrote no manifest as having no results", async () => {
    expect(await collectResults(await results({ "beam/out/manifest.json": new Error("ENOENT: no such file or directory") }))).toEqual({ manifest: null, files: [], unpublished: [] });
  });
});

it("runs jobs only on machines that exist today", async () => {
  const spec: EnvironmentJobSpec = { version: 1, kind: "environment", title: "t", environment: { name: "fea", image: BUILT_IN_ENVIRONMENTS[0]!.image }, command: "true", inputs: [], machine: "8-core", timeoutSeconds: 60 };
  await expect(environmentProcess(spec, "/tmp/x")).rejects.toThrow("not available yet");
});

// Explicit opt-in: needs Docker and the pinned fea image (docker pull it first); never pulls during tests.
const docker = process.env["BEAM_TEST_ENVIRONMENTS"] === "1";
describe.skipIf(!docker)("the fea environment on this computer", () => {
  const image = process.env["BEAM_TEST_ENV_IMAGE"] ?? BUILT_IN_ENVIRONMENTS[0]!.image;
  it("runs a job to completion and publishes a valid manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "beam-env-")), executor = new LocalExecutor(home);
    try {
      const spec: EnvironmentJobSpec = { version: 1, kind: "environment", title: "Cantilever", environment: { name: "fea", image }, command: "mpirun -n 2 python /beam/benchmarks/cantilever.py --nx 10,20,40", inputs: [], machine: "local", timeoutSeconds: 600, parameters: [{ name: "fillet_radius", value: 4, unit: "mm" }], simulation: { caseId: "sim", version: 2 } };
      const handle = await executor.submit("job1", spec, []);
      let status = await executor.inspect(handle);
      for (let i = 0; i < 600 && status.state === "running"; i++) { await new Promise(r => setTimeout(r, 500)); status = await executor.inspect(handle); }
      expect(status.state, status.state === "running" ? "" : status.error ?? "").toBe("succeeded");
      const r = await collectResults(path => executor.readOutput(handle, path));
      expect(r.manifest?.checks.map(c => c.status)).toEqual(["pass", "pass", "pass", "pass"]);
      expect(r.manifest?.provenance.image).toBe(image);
      expect(r.files.length).toBeGreaterThan(8);
      expect(JSON.parse(new TextDecoder().decode(await executor.readOutput(handle, "beam/parameters.json")))).toEqual({ fillet_radius: { value: 4, unit: "mm" } });
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 360_000);
  it("keeps one machine per thread directory, runs commands in /work, and stops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beam-machine-"));
    try {
      await writeFile(join(dir, "hello.txt"), "from the thread directory");
      expect((await openLocalMachine(dir, image, dir)).started).toBe(true);
      expect((await openLocalMachine(dir, image, dir)).started).toBe(false);
      const r = await execOnLocalMachine(dir, "cat hello.txt && python -c 'import dolfinx; print(dolfinx.__version__)' && echo out > made.txt", 60);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("from the thread directory");
      expect(await readFile(join(dir, "made.txt"), "utf8")).toBe("out\n");
      expect((await execOnLocalMachine(dir, "exit 3", 10)).exitCode).toBe(3);
      expect((await execOnLocalMachine(dir, "curl -sS --max-time 3 https://example.com || echo no-network", 10)).stdout).toContain("no-network");
    } finally {
      await closeLocalMachine(dir);
      await expect(promisify(execFile)("docker", ["inspect", machineContainer(dir)])).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
