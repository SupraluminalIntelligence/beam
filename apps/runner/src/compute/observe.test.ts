import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCases, observeMachine, readMachine } from "./observe.ts";

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
