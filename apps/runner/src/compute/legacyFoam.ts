import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BUILT_IN_ENVIRONMENTS, OPENFOAM_IMAGE, SimulationJob, type ProcessJobSpec } from "@beam/contracts";
import { runRecipe, type FoamShell } from "@beam/cfd-recipes";

const exec = promisify(execFile);
const docker = async (image: string) => {
  await exec("docker", ["info", "--format", "{{.OSType}}"], { timeout: 6000 });
  await exec("docker", ["image", "inspect", image], { timeout: 6000, maxBuffer: 1024 * 1024 });
};
/**
 * Where this computer runs the Simulation pane's studies: the cfd environment once its pinned image carries
 * the study recipes, else OpenFOAM's own image, as a process job this runner drives (below).
 */
export async function probeOpenFoam() {
  const cfd = BUILT_IN_ENVIRONMENTS.find(e => e.name === "cfd" && e.studies);
  if (cfd) {
    try { await docker(cfd.image); return { ready: true, message: "OpenFOAM 2512 · cfd environment · local Docker", image: cfd.image }; }
    catch { return { ready: false, message: `Start Docker and install the cfd environment: docker pull ${cfd.image}`, image: cfd.image }; }
  }
  try { await docker(OPENFOAM_IMAGE); return { ready: true, message: "OpenFOAM 2512 · local Docker", image: OPENFOAM_IMAGE }; }
  catch { return { ready: false, message: `Start Docker and install the OpenFOAM runtime: docker pull ${OPENFOAM_IMAGE}`, image: OPENFOAM_IMAGE }; }
}

// Studies submitted before the cfd environment carried the recipes: this runner runs the recipe on the
// host and each OpenFOAM step in OpenFOAM's own image. Remove once no such jobs can be queued.
const containerName = (root: string) => "beam-foam-" + createHash("sha256").update(root).digest("hex").slice(0, 20);
export async function stopFoamContainer(root: string) { await exec("docker", ["rm", "-f", containerName(root)], { timeout: 10000 }); }
export function foamProcess(spec: ProcessJobSpec, root: string) {
  const name = containerName(root);
  const cli = fileURLToPath(import.meta.url.endsWith(".mjs") ? new URL(import.meta.url) : new URL("../cli.ts", import.meta.url));
  return { ...spec, executable: process.execPath, args: [...(cli.endsWith(".ts") ? ["--experimental-strip-types"] : []), cli, "openfoam-job", JSON.stringify(spec.simulation), name], dockerContainer: name };
}
export async function runOpenFoam(raw: unknown, name: string) {
  if (!/^beam-foam-[a-f0-9]{20}$/.test(name)) throw new Error("Invalid container handle");
  const sim = SimulationJob.parse(raw), ready = await probeLegacy();
  if (!ready) throw new Error(`Start Docker and install the OpenFOAM runtime: docker pull ${OPENFOAM_IMAGE}`);
  await runRecipe(sim, process.cwd(), dockerShell(name, sim.config.geometry === "domain3d" ? { cpus: 4, memory: "4g" } : { cpus: 2, memory: "2g" }));
}
const probeLegacy = () => docker(OPENFOAM_IMAGE).then(() => true, () => false);
function dockerShell(name: string, resources: { cpus: number; memory: string }): FoamShell {
  return async (dir, commands, logs) => {
    const script = "source /usr/lib/openfoam/openfoam2512/etc/bashrc; cd /case; set -e; " + commands;
    // No network, credentials or host mounts beyond this job directory. Images are installed explicitly.
    const child = spawn("docker", ["run", "--rm", "--pull=never", "--name", name, "--network", "none", "--cpus", String(resources.cpus), "--memory", resources.memory, "--pids-limit", "256", "-v", `${dir}:/case`, "-w", "/case", "--entrypoint", "/bin/bash", OPENFOAM_IMAGE, "-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", d => process.stdout.write(d)); child.stderr.on("data", d => process.stderr.write(d));
    // Tail the solver log while it runs; the durable supervisor keeps the bounded live log.
    let offset = 0, reading = false;
    const timer = setInterval(async () => { if (reading) return; reading = true; try { const s = await readFile(join(dir, "solve.log"), "utf8"); if (s.length > offset) { process.stdout.write(s.slice(offset)); offset = s.length; } } catch { /* not written yet */ } finally { reading = false; } }, 1000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearInterval(timer));
    if (code !== 0) { for (const path of logs) { try { console.error((await readFile(join(dir, path), "utf8")).slice(-4000)); } catch { /* absent */ } } throw new Error(`OpenFOAM exited with code ${code}`); }
  };
}
