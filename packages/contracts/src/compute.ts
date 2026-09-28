import { z } from "zod";
import { SimulationJob, simulationOutputs, meshInputPath, simulationMeshInputs } from "./simulation.ts";
import { EnvironmentName, ImageRef } from "./environments.ts";
import { MachineId } from "./machines.ts";

/** Portable paths within a job's immutable input snapshot / private working directory. */
export const JobPath = z.string().min(1).max(240).refine(
  value => !/[\\\x00-\x1f:]/.test(value) && value.split("/").every(p => p !== "" && p !== "." && p !== ".."),
  "Use a relative path without empty, dot, or parent segments",
);
export const ProcessJobSpec = z.object({
  version: z.literal(1),
  kind: z.literal("process"),
  title: z.string().trim().min(1).max(120),
  executable: z.string().min(1).max(500).refine(v => !/[\x00-\x1f]/.test(v)),
  args: z.array(z.string().max(8000).refine(v => !v.includes("\0"))).max(100),
  inputs: z.array(z.object({ assetId: z.string().min(1).max(128), path: JobPath }).strict()).max(64),
  outputs: z.array(JobPath).max(16),
  timeoutSeconds: z.number().int().min(1).max(86400),
  simulation: SimulationJob.optional(),
}).strict().superRefine((spec, ctx) => {
  if (spec.simulation || spec.executable === "beam:openfoam") {
    const sim = spec.simulation;
    if (!sim || spec.executable !== "beam:openfoam" || spec.args.length || JSON.stringify(spec.outputs)!==JSON.stringify(simulationOutputs(sim.stage,sim.config)) || (sim.stage==="mesh" ? JSON.stringify(spec.inputs.map(i=>i.path))!==JSON.stringify(simulationMeshInputs(sim.config).map(i=>i.path)) : spec.inputs.length!==1 || spec.inputs[0]?.path!==meshInputPath(sim.config) || !sim.meshJobId))
      ctx.addIssue({code:"custom",message:"Invalid OpenFOAM job manifest"});
  }
  if (JSON.stringify(spec).length > 48_000)
    ctx.addIssue({ code: "custom", message: "Job specification must be smaller than 48,000 characters" });
  for (const paths of [spec.inputs.map(i => i.path), spec.outputs]) {
    if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Duplicate job paths" });
    if (paths.some(p => paths.some(other => other !== p && other.startsWith(`${p}/`))))
      ctx.addIssue({ code: "custom", message: "A file path cannot also be a directory" });
  }
});
export type ProcessJobSpec = z.infer<typeof ProcessJobSpec>;

/**
 * A command in an environment on a machine. The command runs with `bash -lc` inside the environment's
 * container, in a working directory holding the inputs; unlike ProcessJobSpec it may use a shell, because
 * the container, not the host, is the boundary. Results are whatever the job writes under beam/out,
 * described by beam/out/manifest.json (see results.ts), so there is no output list.
 */
export const EnvironmentJobSpec = z.object({
  version: z.literal(1),
  kind: z.literal("environment"),
  title: z.string().trim().min(1).max(120),
  environment: z.object({ name: EnvironmentName, image: ImageRef }).strict(),
  command: z.string().trim().min(1).max(8000).refine(v => !v.includes("\0"), "Commands cannot contain NUL"),
  inputs: z.array(z.object({ assetId: z.string().min(1).max(128), path: JobPath }).strict()).max(64),
  machine: MachineId,
  timeoutSeconds: z.number().int().min(1).max(86400),
  /** Written to beam/parameters.json before the command runs. */
  parameters: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), value: z.union([z.number().finite(), z.string().max(200), z.boolean()]), unit: z.string().max(40) }).strict()).max(64).optional(),
  /** The simulation version this job runs. */
  simulation: z.object({ caseId: z.string().min(1).max(128), version: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((spec, ctx) => {
  if (JSON.stringify(spec).length > 48_000)
    ctx.addIssue({ code: "custom", message: "Job specification must be smaller than 48,000 characters" });
  const paths = spec.inputs.map(i => i.path);
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Duplicate job paths" });
  if (paths.some(p => paths.some(other => other !== p && other.startsWith(`${p}/`))))
    ctx.addIssue({ code: "custom", message: "A file path cannot also be a directory" });
  if (paths.some(p => p === "beam" || p === "beam/out" || p.startsWith("beam/out/")))
    ctx.addIssue({ code: "custom", message: "beam/out is reserved for the job's results" });
  if (spec.parameters && paths.includes("beam/parameters.json"))
    ctx.addIssue({ code: "custom", message: "beam/parameters.json is written from the job's parameters" });
});
export type EnvironmentJobSpec = z.infer<typeof EnvironmentJobSpec>;
export const JobSpec = z.union([ProcessJobSpec, EnvironmentJobSpec]);
export type JobSpec = z.infer<typeof JobSpec>;
export const JobState = z.enum(["awaiting-approval", "queued", "preparing", "running", "publishing", "succeeded", "failed", "cancelled"]);
export type JobState = z.infer<typeof JobState>;
export const jobFinished = (state: string) => ["succeeded", "failed", "cancelled"].includes(state);
export const MAX_COMPUTE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_COMPUTE_INPUT_BYTES = 100 * 1024 * 1024;

/**
 * An executor could not reach its provider, so the job's state is unknown, not failed. Reconciliation
 * leaves the job as it is and tries again on the next pass, until the provider answers.
 */
export class ExecutorUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "ExecutorUnavailable"; }
}

/** Scheduler-neutral resource reference. Future backends own their handle's format. */
export interface ExecutionHandle { backend: string; id: string }
export interface ComputeInput { path: string; url: string; size: number; sha256: string }
export type ExecutionStatus =
  | { state: "running"; log: string }
  | { state: "succeeded" | "failed" | "cancelled"; log: string; error: string | null; exitCode: number | null };

/** submit must be idempotent for jobId. inspect must work after the connector restarts. */
export interface ComputeExecutor {
  readonly backend: string;
  /** Return the existing opaque handle; null only when this job was never submitted. */
  recover(jobId: string): Promise<ExecutionHandle | null>;
  /** Persist cancellation by Beam job ID, including a submission racing before its handle is saved. */
  cancelSubmission(jobId: string): Promise<void>;
  submit(jobId: string, spec: JobSpec, inputs: ComputeInput[]): Promise<ExecutionHandle>;
  inspect(handle: ExecutionHandle): Promise<ExecutionStatus>;
  cancel(handle: ExecutionHandle): Promise<void>;
  readOutput(handle: ExecutionHandle, path: string): Promise<Uint8Array>;
  /** Frees the machine once the job's outcome is recorded in Beam. Optional: a local process has nothing to hold. */
  release?(handle: ExecutionHandle): Promise<void>;
}
