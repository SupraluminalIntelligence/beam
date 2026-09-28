import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EnvironmentJobSpec, JobSpec } from "./compute";
import { EnvironmentDescription, ImageRef } from "./environments";
import { MACHINES, usefulProcesses } from "./machines";

const IMAGE = "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:52b46d54c99ce66680ced634a6fca2aa900d118b6089f2df0324184ed940ec0b";

it("parses every env.json in environments/", () => {
  const env = JSON.parse(readFileSync(new URL("../../../environments/fea/env.json", import.meta.url), "utf8"));
  expect(EnvironmentDescription.parse(env)).toMatchObject({ name: "fea", kind: "built-in", benchmarks: [{ name: "cantilever" }] });
});

it("names images by digest only", () => {
  expect(ImageRef.safeParse(IMAGE).success).toBe(true);
  for (const ref of ["ghcr.io/supraluminalintelligence/beam-env-fea:latest", "beam-env-fea@sha256:" + "0".repeat(64), IMAGE.slice(0, -1)])
    expect(ImageRef.safeParse(ref).success, ref).toBe(false);
});

it("accepts an environment job and keeps beam/out for results", () => {
  const spec = { version: 1, kind: "environment", title: "Bracket v4", environment: { name: "fea", image: IMAGE },
    command: "mpirun -n 8 python solve.py && python post.py", inputs: [{ assetId: "a1", path: "setup/bracket.geo" }], machine: "8-core", timeoutSeconds: 7200 };
  expect(EnvironmentJobSpec.parse(spec).machine).toBe("8-core");
  expect(JobSpec.parse(spec).kind).toBe("environment");
  expect(JobSpec.parse({ version: 1, kind: "process", title: "t", executable: "python3", args: [], inputs: [], outputs: [], timeoutSeconds: 60 }).kind).toBe("process");
  const invalid = (change: object) => EnvironmentJobSpec.safeParse({ ...spec, ...change }).success;
  expect(invalid({ inputs: [{ assetId: "a", path: "beam/out/manifest.json" }] })).toBe(false);
  expect(invalid({ machine: "128-core" })).toBe(false);
  expect(invalid({ environment: { name: "fea", image: "ghcr.io/x/y:latest" } })).toBe(false);
  expect(invalid({ command: "  " })).toBe(false);
  expect(invalid({ outputs: ["x"] })).toBe(false);
});

it("caps MPI processes at 8 on Modal and uses every core on a whole node", () => {
  expect(usefulProcesses(MACHINES["8-core"])).toBe(8);
  expect(usefulProcesses(MACHINES["gpu-8"])).toBe(8);
  expect(usefulProcesses(MACHINES["96-core"])).toBe(96);
  expect(usefulProcesses(MACHINES["local"], 12)).toBe(12);
});
