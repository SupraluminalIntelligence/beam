import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JobPath, ProcessJobSpec, MAX_COMPUTE_FILE_BYTES, MAX_COMPUTE_INPUT_BYTES } from "@beam/contracts";
import type { ComputeExecutor, ComputeInput, ExecutionHandle, ExecutionStatus } from "@beam/contracts";

export async function readJobFile(directory: string, path: string): Promise<Uint8Array> {
  JobPath.parse(path);
  const root = await realpath(directory), file = await realpath(join(root, path));
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("File escapes the job directory");
  const meta = await stat(file);
  if (!meta.isFile() || meta.size > MAX_COMPUTE_FILE_BYTES) throw new Error("Job files must be regular files of 20 MB or less");
  const bytes = await readFile(file);
  if (bytes.length > MAX_COMPUTE_FILE_BYTES) throw new Error("Job file grew beyond the size limit");
  return bytes;
}
const Result = z.object({ state: z.enum(["succeeded", "failed", "cancelled"]), log: z.string(), error: z.string().nullable(), exitCode: z.number().nullable() });
async function json(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Local receipts implement the same handle contract a scheduler job ID will implement later. */
export class LocalExecutor implements ComputeExecutor {
  readonly backend = "local-process";
  readonly home: string;
  constructor(home: string) { this.home = home; }
  private root(handle: ExecutionHandle) {
    if (handle.backend !== this.backend || !/^[\w-]+$/.test(handle.id)) throw new Error("Invalid local execution handle");
    return join(this.home, handle.id);
  }
  async recover(jobId: string): Promise<ExecutionHandle | null> {
    const handle = { backend: this.backend, id: jobId };
    return await json(join(this.root(handle), "launch.json")) ? handle : null;
  }
  async cancelSubmission(jobId: string) { await this.cancel({ backend: this.backend, id: jobId }); }
  async submit(jobId: string, raw: ProcessJobSpec, inputs: ComputeInput[]): Promise<ExecutionHandle> {
    const spec = ProcessJobSpec.parse(raw);
    if (process.platform === "win32") throw new Error("Run the compute runner inside WSL on Windows");
    const handle = { backend: this.backend, id: jobId }, root = this.root(handle);
    await mkdir(root, { recursive: true });
    // Exclusive marker: an uncertain launch is inspected, never automatically replayed.
    try { await writeFile(join(root, "launch.json"), JSON.stringify({ at: Date.now() }), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return handle; throw error; }
    try {
      if (inputs.length !== spec.inputs.length || inputs.some((i, n) => i.path !== spec.inputs[n]?.path) || inputs.reduce((n, i) => n + i.size, 0) > MAX_COMPUTE_INPUT_BYTES) throw new Error("Invalid input manifest");
      await mkdir(join(root, "work"), { recursive: true });
      const downloadDeadline = AbortSignal.timeout(60_000);
      for (const input of inputs) {
        JobPath.parse(input.path);
        if (input.size > MAX_COMPUTE_FILE_BYTES || input.size < 0) throw new Error("Input exceeds the local file limit");
        const response = await fetch(input.url, { signal: downloadDeadline });
        if (!response.ok || !response.body) throw new Error(`Input download failed: ${response.status}`);
        const chunks: Uint8Array[] = []; let total = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.byteLength;
          if (total > input.size) throw new Error("Input size mismatch");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const base64 = Buffer.from(digest, "hex").toString("base64");
        if (total !== input.size || (digest !== input.sha256 && base64 !== input.sha256)) throw new Error("Input snapshot checksum mismatch");
        const dest = join(root, "work", input.path);
        await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes, { flag: "wx" });
      }
      await writeFile(join(root, "spec.json"), JSON.stringify(spec));
      const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.mjs", import.meta.url)), root], {
        detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } catch (error) {
      await writeFile(join(root, "result.tmp"), JSON.stringify({ state: "failed", log: "", error: (error as Error).message, exitCode: null }));
      await rename(join(root, "result.tmp"), join(root, "result.json"));
    }
    return handle;
  }
  async inspect(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const root = this.root(handle);
    const result = await json(join(root, "result.json"));
    if (result) return Result.parse(result);
    const status = await json(join(root, "status.json")) as { heartbeatAt: number; log: string } | null;
    const launch = await json(join(root, "launch.json")) as { at: number } | null;
    if (!launch) throw new Error("Local execution receipt is missing; the job will not be replayed");
    if (Date.now() - (status?.heartbeatAt ?? launch.at) > 90_000) {
      await this.cancel(handle);
      return { state: "failed", log: status?.log ?? "", error: "Local supervisor stopped responding. Inspect the machine before submitting a new job; this execution was not replayed.", exitCode: null };
    }
    return { state: "running", log: status?.log ?? "" };
  }
  async cancel(handle: ExecutionHandle) { const root = this.root(handle); await mkdir(root, { recursive: true }); await writeFile(join(root, "cancel"), "cancel"); }
  async readOutput(handle: ExecutionHandle, path: string) { return readJobFile(join(this.root(handle), "work"), path); }
}
