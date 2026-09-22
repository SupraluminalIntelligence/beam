import { z } from "zod";

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
}).strict().superRefine((spec, ctx) => {
  if (JSON.stringify(spec).length > 48_000)
    ctx.addIssue({ code: "custom", message: "Job specification must be smaller than 48,000 characters" });
  for (const paths of [spec.inputs.map(i => i.path), spec.outputs]) {
    if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Duplicate job paths" });
    if (paths.some(p => paths.some(other => other !== p && other.startsWith(`${p}/`))))
      ctx.addIssue({ code: "custom", message: "A file path cannot also be a directory" });
  }
});
export type ProcessJobSpec = z.infer<typeof ProcessJobSpec>;
export const JobState = z.enum(["awaiting-approval", "queued", "preparing", "running", "publishing", "succeeded", "failed", "cancelled"]);
export type JobState = z.infer<typeof JobState>;
export const jobFinished = (state: string) => ["succeeded", "failed", "cancelled"].includes(state);
export const MAX_COMPUTE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_COMPUTE_INPUT_BYTES = 100 * 1024 * 1024;

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
  submit(jobId: string, spec: ProcessJobSpec, inputs: ComputeInput[]): Promise<ExecutionHandle>;
  inspect(handle: ExecutionHandle): Promise<ExecutionStatus>;
  cancel(handle: ExecutionHandle): Promise<void>;
  readOutput(handle: ExecutionHandle, path: string): Promise<Uint8Array>;
}
