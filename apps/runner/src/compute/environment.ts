import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { EnvironmentJobSpec } from "@beam/contracts";

/**
 * Environments on this computer: a job runs in a fresh container of its environment's image; a chat's
 * machine is one long-lived container per chat with the thread's working directory mounted at /work.
 * Both use the OpenFOAM jobs' boundary: no network, --pull=never, CPU, memory and process limits, and
 * only one directory mounted.
 */
const exec = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);
export const jobContainer = (root: string) => `beam-env-${hash(root)}`;
/** One machine per thread directory: a chat, or a scope within it. */
export const machineContainer = (directory: string) => `beam-machine-${hash(directory)}`;
const MACHINE_IDLE_SECONDS = 30 * 60;

/** Docker's view of this computer. A container's user must be able to write the mounted directory on Linux; Docker Desktop maps it. */
async function dockerHost() {
  const { stdout } = await exec("docker", ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { timeout: 6000 });
  const [cpus, memory] = stdout.trim().split(" ").map(Number);
  return { cpus: Math.max(1, cpus || 1), memoryBytes: memory || 0 };
}
const userArgs = () => process.platform === "linux" && process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`, "-e", "HOME=/tmp"] : [];
const envArgs = (vars: Record<string, string>) => Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

export async function environmentAvailable(image: string) {
  try { await exec("docker", ["info", "--format", "{{.OSType}}"], { timeout: 6000 }); }
  catch { throw new Error("Docker is not running on this computer. Start Docker Desktop, then try again."); }
  try { await exec("docker", ["image", "inspect", image], { timeout: 6000, maxBuffer: 1 << 20 }); }
  catch { throw new Error(`This environment is not installed on this computer. Install it once with: docker pull ${image}`); }
}

/** The worker's process for an environment job: docker run of the command, removed afterwards. */
export async function environmentProcess(raw: EnvironmentJobSpec, root: string) {
  const spec = EnvironmentJobSpec.parse(raw);
  if (spec.machine !== "local") throw new Error(`The ${spec.machine} machine is not available yet; run this job on "local"`);
  const { cpus } = await dockerHost(), name = jobContainer(root);
  const args = ["run", "--rm", "--pull=never", "--name", name, "--network", "none", "--cpus", String(cpus), "--pids-limit", "4096", "--shm-size", "1g",
    "-v", `${root}/work:/work`, "-w", "/work", ...userArgs(),
    ...envArgs({ BEAM_IMAGE: spec.environment.image, BEAM_COMMAND: spec.command, BEAM_CORES: String(cpus) }),
    "--entrypoint", "/bin/bash", spec.environment.image, "-lc", spec.command];
  return { executable: "docker", args, timeoutSeconds: spec.timeoutSeconds, dockerContainer: name, environment: spec.environment.name };
}
export async function stopJobContainer(root: string) { await exec("docker", ["rm", "-f", jobContainer(root)], { timeout: 10000 }); }

export { collectResults, type CollectedResults } from "@beam/contracts";

/** The chat's machine on this computer. It stops itself after 30 idle minutes; each command resets the clock. */
export async function openLocalMachine(key: string, image: string, directory: string) {
  await environmentAvailable(image);
  const name = machineContainer(key), { cpus } = await dockerHost();
  const running = await exec("docker", ["inspect", "-f", "{{.State.Running}} {{.Config.Image}}", name], { timeout: 6000 }).then(r => r.stdout.trim(), () => "");
  if (running === `true ${image}`) return { name, cpus, started: false };
  if (running) await exec("docker", ["rm", "-f", name], { timeout: 10000 });
  const idle = `touch /tmp/.beam-used; while [ $(( $(date +%s) - $(stat -c %Y /tmp/.beam-used) )) -lt ${MACHINE_IDLE_SECONDS} ]; do sleep 30; done`;
  await exec("docker", ["run", "-d", "--rm", "--pull=never", "--name", name, "--label", "beam.machine=local", "--network", "none", "--cpus", String(cpus), "--pids-limit", "4096", "--shm-size", "1g",
    "-v", `${directory}:/work`, "-w", "/work", ...userArgs(), ...envArgs({ BEAM_IMAGE: image, BEAM_CORES: String(cpus) }),
    "--entrypoint", "/bin/bash", image, "-c", idle], { timeout: 60000 });
  return { name, cpus, started: true };
}

const MAX_OUTPUT = 16_000;
export async function execOnLocalMachine(key: string, command: string, timeoutSeconds: number) {
  const name = machineContainer(key), started = Date.now();
  try {
    const { stdout, stderr } = await exec("docker", ["exec", "-w", "/work", name, "/bin/bash", "-lc", `touch /tmp/.beam-used; ${command}`], { timeout: timeoutSeconds * 1000, maxBuffer: 64 << 20 });
    return { exitCode: 0, stdout: stdout.slice(-MAX_OUTPUT), stderr: stderr.slice(-MAX_OUTPUT), seconds: (Date.now() - started) / 1000 };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message: string };
    if (/No such container|is not running/.test(err.stderr ?? err.message)) throw new Error("This chat's machine is not running. Call machine_open first.");
    return { exitCode: typeof err.code === "number" ? err.code : null, timedOut: !!err.killed, stdout: (err.stdout ?? "").slice(-MAX_OUTPUT), stderr: (err.stderr ?? err.message).slice(-MAX_OUTPUT), seconds: (Date.now() - started) / 1000 };
  }
}
export async function closeLocalMachine(key: string) {
  await exec("docker", ["rm", "-f", machineContainer(key)], { timeout: 10000 }).catch(() => {});
}
