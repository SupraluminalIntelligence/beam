import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import { JobPath, JobSpec, MACHINES, MAX_COMPUTE_FILE_BYTES, MAX_COMPUTE_INPUT_BYTES, MachineId, usefulProcesses } from "@beam/contracts";
import type { ComputeExecutor, ComputeInput, ExecutionHandle, ExecutionStatus } from "@beam/contracts";
import { FileMissing, type ModalPort, type SandboxPort } from "./port.ts";
import { LAUNCH_ABANDONED, SUPERVISOR, TIMED_OUT } from "./supervisor.ts";

export const JOB_DIR = "/tmp/beam-job";
export const WORK = "/work";
const LAUNCH_WINDOW_SECONDS = 600;
/** How long a finished sandbox waits for Beam to collect its outputs. */
const COLLECT_WINDOW_SECONDS = 3600;
/** Modal's longest sandbox lifetime. */
const MODAL_MAX_SECONDS = 24 * 3600;
const LOG_BYTES = 16_000;

export const sandboxName = (jobId: string) => `beam-job-${jobId}`;

/** The Modal resources for one of Beam's machine sizes; only machines Modal backs are accepted. */
export function sandboxShape(id: MachineId) {
  const machine = MACHINES[MachineId.parse(id)];
  if (machine.backend !== "modal-sandbox" && machine.backend !== "modal-function")
    throw new Error(`The ${machine.label} does not run on Modal. Cloud jobs can use: ${Object.values(MACHINES).filter(m => m.backend.startsWith("modal")).map(m => m.id).join(", ")}.`);
  const gpu = machine.gpus ? (machine.gpus.count > 1 ? `${machine.gpus.model}:${machine.gpus.count}` : machine.gpus.model) : undefined;
  return { cpu: machine.cores!, memoryMiB: machine.memoryGiB! * 1024, cores: usefulProcesses(machine), ...(gpu ? { gpu } : {}) };
}

async function download(input: ComputeInput, deadline: AbortSignal): Promise<Uint8Array> {
  if (input.size > MAX_COMPUTE_FILE_BYTES || input.size < 0) throw new Error(`Input ${input.path} exceeds the 20 MB file limit`);
  const response = await fetch(input.url, { signal: deadline });
  if (!response.ok) throw new Error(`Input download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest();
  if (bytes.length !== input.size || (digest.toString("hex") !== input.sha256 && digest.toString("base64") !== input.sha256))
    throw new Error("Input snapshot checksum mismatch");
  return bytes;
}

const text = (s: string) => new TextEncoder().encode(s);
async function readTextOrNull(sandbox: SandboxPort, path: string) {
  try { return new TextDecoder().decode(await sandbox.readBytes(path)); }
  catch (e) { if (e instanceof FileMissing) return null; throw e; }
}

/**
 * Runs environment jobs in Modal Sandboxes: one named sandbox per job, created from the environment's
 * image by digest, with no network. The job's handle is the sandbox ID. Like the local executor, a launch
 * whose outcome is uncertain is inspected and never replayed.
 *
 * Long batch solves belong on Modal Functions, which cost about a third as much per core-second
 * (docs/decisions/2026-09-27-compute-plane.md). Functions can only be defined in Python, so this first
 * executor runs every size as a Sandbox.
 */
export class ModalExecutor implements ComputeExecutor {
  readonly backend = "modal-sandbox";
  private readonly cancelled = new Set<string>();
  constructor(private readonly modal: ModalPort) {}

  private async sandbox(handle: ExecutionHandle) {
    if (handle.backend !== this.backend) throw new Error("Invalid Modal execution handle");
    return this.modal.fromId(handle.id);
  }

  async recover(jobId: string): Promise<ExecutionHandle | null> {
    const found = await this.modal.fromName(sandboxName(jobId));
    return found ? { backend: this.backend, id: found.id } : null;
  }

  async cancelSubmission(jobId: string) {
    this.cancelled.add(jobId);
    await (await this.modal.fromName(sandboxName(jobId)))?.terminate();
  }

  async submit(jobId: string, raw: JobSpec, inputs: ComputeInput[]): Promise<ExecutionHandle> {
    const spec = JobSpec.parse(raw);
    if (spec.kind !== "environment") throw new Error("Cloud machines run environment jobs. OpenFOAM study jobs run on the engineer's computer.");
    if (this.cancelled.has(jobId)) throw new Error("Cancelled before launch");
    const shape = sandboxShape(spec.machine);
    const lifetime = LAUNCH_WINDOW_SECONDS + spec.timeoutSeconds + COLLECT_WINDOW_SECONDS;
    if (lifetime > MODAL_MAX_SECONDS)
      throw new Error(`Cloud jobs can run for at most ${Math.floor((MODAL_MAX_SECONDS - LAUNCH_WINDOW_SECONDS - COLLECT_WINDOW_SECONDS) / 360) / 10} hours`);
    if (inputs.length !== spec.inputs.length || inputs.some((input, n) => input.path !== spec.inputs[n]?.path) || inputs.reduce((n, i) => n + i.size, 0) > MAX_COMPUTE_INPUT_BYTES)
      throw new Error("Invalid input manifest");

    const { sandbox, created } = await this.modal.create({
      name: sandboxName(jobId),
      image: spec.environment.image,
      command: ["bash", "-c", SUPERVISOR],
      env: {
        BEAM_COMMAND: spec.command, BEAM_TIMEOUT: String(spec.timeoutSeconds), BEAM_CORES: String(shape.cores),
        BEAM_IMAGE: spec.environment.image, BEAM_JOB_DIR: JOB_DIR, BEAM_WORK: WORK, BEAM_LAUNCH_WINDOW: String(LAUNCH_WINDOW_SECONDS),
      },
      cpu: shape.cpu, cpuLimit: shape.cpu, memoryMiB: shape.memoryMiB, memoryLimitMiB: shape.memoryMiB, ...(shape.gpu ? { gpu: shape.gpu } : {}),
      timeoutMs: lifetime * 1000,
      tags: { beamJob: jobId, environment: spec.environment.name, machine: spec.machine },
    });
    const handle = { backend: this.backend, id: sandbox.id };
    // An earlier submit created it and may have written `go`: inspect that launch, never stage it twice.
    if (!created) return handle;
    try {
      await sandbox.makeDirectory(JOB_DIR);
      const deadline = AbortSignal.timeout(60_000);
      for (const input of inputs) {
        const path = `${WORK}/${JobPath.parse(input.path)}`;
        const bytes = await download(input, deadline);
        await sandbox.makeDirectory(dirname(path));
        await sandbox.writeBytes(bytes, path);
      }
      if (this.cancelled.has(jobId)) throw new Error("Cancelled before launch");
      await sandbox.writeBytes(text(""), `${JOB_DIR}/go`);
    } catch (e) {
      // Recorded in the sandbox so inspect reports it; the command never starts.
      await sandbox.writeBytes(text((e as Error).message), `${JOB_DIR}/setup-error`);
      await sandbox.writeBytes(text(""), `${JOB_DIR}/abort`);
    }
    return handle;
  }

  async inspect(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const sandbox = await this.sandbox(handle);
    const failed = (error: string, log = "", exitCode: number | null = null): ExecutionStatus => ({ state: "failed", log, error, exitCode });
    if (!sandbox) return failed("The cloud machine for this job no longer exists. The job was not run again.");
    const stopped = await sandbox.poll();
    if (stopped === LAUNCH_ABANDONED) return failed("The job's launch was interrupted before its command started. It was not run.");
    if (stopped !== null) return failed("The cloud machine stopped before the job's results were collected: it was cancelled, ran out of time or ran out of memory.");
    const setupError = await readTextOrNull(sandbox, `${JOB_DIR}/setup-error`);
    if (setupError !== null) return failed(setupError);
    const exit = await readTextOrNull(sandbox, `${JOB_DIR}/exit`);
    const tail = await sandbox.exec(["tail", "-c", String(LOG_BYTES), `${JOB_DIR}/log`]);
    const log = tail.exitCode === 0 ? tail.stdout : "";
    if (exit === null) return { state: "running", log };
    const code = Number(exit.trim());
    if (code === 0) return { state: "succeeded", log, error: null, exitCode: 0 };
    if (code === TIMED_OUT) return failed("The command ran past the job's time limit and was stopped.", log, code);
    if (code === 137) return failed("The command was killed (exit 137), most often because it ran out of memory.", log, code);
    return failed(`The command exited with code ${code}.`, log, Number.isFinite(code) ? code : null);
  }

  /** Returns once Modal confirms the sandbox has stopped, so a cancelled job is known to have stopped spending. */
  async cancel(handle: ExecutionHandle) { await (await this.sandbox(handle))?.terminate(); }

  async readOutput(handle: ExecutionHandle, path: string): Promise<Uint8Array> {
    const sandbox = await this.sandbox(handle);
    if (!sandbox) throw new Error("The cloud machine for this job no longer exists");
    const file = `${WORK}/${JobPath.parse(path)}`;
    if (await sandbox.size(file) > MAX_COMPUTE_FILE_BYTES) throw new Error("Job files must be regular files of 20 MB or less");
    const bytes = await sandbox.readBytes(file);
    if (bytes.length > MAX_COMPUTE_FILE_BYTES) throw new Error("Job file grew beyond the size limit");
    return bytes;
  }

  /** Stops the sandbox once its outputs are published. Until then it holds the results. */
  async release(handle: ExecutionHandle) { await this.cancel(handle); }
}
