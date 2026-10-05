import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, cp, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCases, observeMachine, readMachine, type Memory } from "./observe.ts";
import { jobWatcher } from "./watch.ts";

const FIXTURES = new URL("../../../../packages/observe/src/fixtures/", import.meta.url).pathname;
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** A thread directory as the airfoil agent left it mid-trial: a meshed, running case and a case with only dictionaries. */
async function thread() {
  root = await mkdtemp(join(tmpdir(), "beam-observe-"));
  const coarse = join(root, "naca0012/run/coarse");
  for (const dir of ["system", "constant/polyMesh", "0", "processor0/system", "postProcessing/forceCoeffs", "postProcessing/yPlus/0"]) await mkdir(join(coarse, dir), { recursive: true });
  await writeFile(join(coarse, "system/controlDict"), "application simpleFoam;\n");
  await writeFile(join(coarse, "processor0/system/controlDict"), "decomposed copy\n");
  await writeFile(join(coarse, "constant/polyMesh/owner"), "mesh\n");
  await cp(join(FIXTURES, "simpleFoam.txt"), join(coarse, "log.simpleFoam"));
  await cp(join(FIXTURES, "checkMesh.txt"), join(coarse, "log.checkMesh"));
  await writeFile(join(coarse, "log.blockMesh"), "End\n");
  await cp(join(FIXTURES, "forceCoeffs"), join(coarse, "postProcessing/forceCoeffs"), { recursive: true });
  await cp(join(FIXTURES, "yPlus/0/yPlus.dat"), join(coarse, "postProcessing/yPlus/0/yPlus.dat"));
  const draft = join(root, "scratch/m");
  await mkdir(join(draft, "system"), { recursive: true });
  await writeFile(join(draft, "system/controlDict"), "application simpleFoam;\n");
  return coarse;
}

describe("reading a thread directory", () => {
  it("finds cases, skipping decomposed copies, and draws the one with real work", async () => {
    await thread();
    expect((await findCases(root)).sort()).toEqual(["naca0012/run/coarse", "scratch/m"]);
    const reading = (await readMachine(root, { text: "mpirun -n 4 simpleFoam -parallel", startedAt: 1 }))!;
    expect(reading.view.case).toMatchObject({ path: "naca0012/run/coarse", solver: "simpleFoam", state: "done" });
    expect(reading.view.cases.map(c => c.path)).toEqual(["naca0012/run/coarse"]);
    expect(reading.view.series.map(s => s.name)).toEqual(["residuals", "coeff-Cd", "coeff-Cl", "coeff-CmPitch", "yplus-airfoil"]);
    expect(reading.view.mesh?.cells).toBe(33792);
    expect(reading.view.command?.text).toMatch(/simpleFoam/);
  });
  it("says a case is running while its log grows, and shows nothing before any case has a mesh or a log", async () => {
    const coarse = await thread();
    await writeFile(join(coarse, "log.simpleFoam"), "Exec   : simpleFoam -parallel\nTime = 1\n\nGAMG:  Solving for p, Initial residual = 1, Final residual = 0.01, No Iterations 3\n");
    expect((await readMachine(root, null))!.view.case.state).toBe("running");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(coarse, "log.simpleFoam"), old, old);
    expect((await readMachine(root, null))!.view.case.state).toBe("stopped");
    await rm(join(root, "naca0012"), { recursive: true });
    expect(await readMachine(root, null)).toBeNull();
  });
});

it("keeps a long run's whole history, reading only what each log gained, and starts over when it is rewritten", async () => {
  const coarse = await thread(), path = join(coarse, "log.simpleFoam");
  // About 9 MB, like the 512 × 512 cavity's log after 13,546 iterations.
  const step = (i: number) => `Time = ${i}\n\nsmoothSolver:  Solving for Ux, Initial residual = ${1 / i}, Final residual = 1e-9, No Iterations 4\n${"ExecutionTime = 1 s  ClockTime = 1 s\n".repeat(16)}\n`;
  await writeFile(path, "Exec   : simpleFoam\n" + Array.from({ length: 13_000 }, (_, i) => step(i + 1)).join(""));
  const memory: Memory = new Map(), iterations = (r: Awaited<ReturnType<typeof readMachine>>) => r!.view.series[0]!.xs;
  const first = await readMachine(root, null, Date.now(), memory);
  expect(iterations(first)[0]).toBe(1);
  expect(iterations(first).at(-1)).toBe(13_000);
  await appendFile(path, step(13_001) + "Time = 13002\n\nsmoothSolver:  Solving for Ux, Initial resid");
  const grown = iterations(await readMachine(root, null, Date.now(), memory));
  // Step 13002 has begun; its half-written line waits for the next pass.
  expect([grown[0], grown.at(-1)]).toEqual([1, 13_002]);
  expect(memory.get(path)!.offset).toBe((await stat(path)).size - "smoothSolver:  Solving for Ux, Initial resid".length);
  await writeFile(path, "Exec   : pimpleFoam\nTime = 0.5\n\nsmoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 1e-9, No Iterations 4\n");
  const rewritten = (await readMachine(root, null, Date.now(), memory))!;
  expect(rewritten.view.case.solver).toBe("pimpleFoam");
  expect(rewritten.view.series[0]!.xs).toEqual([0.5]);
});

it("publishes when the solver's output changes, and not otherwise, up to its last reading on stop", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const coarse = await thread();
    const published: number[] = [];
    const watch = observeMachine(root, async view => { published.push(view.quantities.find(q => q.name === "iteration")?.value ?? -1); }, () => null, () => {}, 1000);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(published).toHaveLength(1);
    await appendFile(join(coarse, "log.simpleFoam"), "Time = 2101\n\nGAMG:  Solving for p, Initial residual = 0.001, Final residual = 1e-5, No Iterations 3\n");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(published.at(-1)).toBe(2101);
    await watch.stop();
    expect(published).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it("reports a running job's working directory as it changes, at most every few seconds, and lets an ended job go", async () => {
  const coarse = await thread(), home = await mkdtemp(join(tmpdir(), "beam-jobs-"));
  try {
    await mkdir(join(home, "job1"));
    await symlink(root, join(home, "job1", "work"));
    const sent: { id: string; iteration: number | undefined; state: string }[] = [];
    const client = { mutation: async (_: unknown, a: { id: string; view: { quantities: { name: string; value: number }[]; case: { state: string } } }) => { sent.push({ id: a.id, iteration: a.view.quantities.find(q => q.name === "iteration")?.value, state: a.view.case.state }); } };
    const watch = jobWatcher(client as never, "valid", home, () => {});
    const job = (state: string) => ({ _id: "job1", state, createdAt: 1, startedAt: 2, spec: { version: 1, kind: "environment", title: "Polar", environment: { name: "cfd", image: "ghcr.io/supraluminalintelligence/beam-env-cfd@sha256:" + "a".repeat(64) }, command: "./Allrun", inputs: [], machine: "local", timeoutSeconds: 600 } }) as never;
    await watch(job("running"), 10_000);
    await watch(job("running"), 11_000);
    expect(sent).toEqual([{ id: "job1", iteration: 2100, state: "done" }]);
    await appendFile(join(coarse, "log.simpleFoam"), "Exec   : simpleFoam\nTime = 2101\n\nGAMG:  Solving for p, Initial residual = 0.001, Final residual = 1e-5, No Iterations 3\n");
    await watch(job("running"), 12_000);
    expect(sent).toHaveLength(1);
    await watch(job("running"), 14_500);
    expect(sent.at(-1)).toEqual({ id: "job1", iteration: 2101, state: "running" });
    await watch(job("succeeded"), 20_000);
    expect(sent).toHaveLength(2);
  } finally { await rm(home, { recursive: true, force: true }); }
});
