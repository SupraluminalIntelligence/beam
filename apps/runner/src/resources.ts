import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, dirname, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api.js";
import { ResourceOperation } from "../../../packages/contracts/src/resources.ts";
import { beamHome } from "./config.ts";
import type { BeamTool } from "@beam/harness";

const execute = promisify(execFile);
const LocalResource = z.discriminatedUnion("kind", [z.object({ kind: z.literal("folder"), path: z.string() }), z.object({ kind: z.literal("service"), port: z.number().int().min(1024).max(65535) })]);
const localDirectory = () => join(beamHome(), "resources");
export async function contributeResource(client: ConvexClient, token: string, chatId: Id<"chats">, name: string, input: unknown) {
  let resource = LocalResource.parse(input);
  if (resource.kind === "folder") {
    if (!isAbsolute(resource.path)) throw new Error("Choose an absolute directory");
    resource = { kind: "folder", path: await realpath(resource.path) };
    if (!(await stat(resource.path)).isDirectory()) throw new Error("Choose a folder");
  }
  const localId = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  await mkdir(localDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(join(localDirectory(), `${localId}.json`), JSON.stringify(resource), { mode: 0o600 });
  return client.mutation(api.resources.contribute, { token, chatId, localId, name, kind: resource.kind });
}

export async function containedPath(root: string, path: string, creating = false) {
  if (isAbsolute(path) || path.includes("\0")) throw new Error("Use a relative path inside the shared folder");
  const canonicalRoot = await realpath(root);
  const target = join(canonicalRoot, path);
  const canonical = creating ? join(await realpath(dirname(target)), basename(target)) : await realpath(target);
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("Path leaves the shared folder");
  return canonical;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function readText(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await fd.stat(); if (!info.isFile() || info.size > 200_000) throw new Error("Read a text file up to 200 KB"); return await fd.readFile("utf8"); } finally { await fd.close(); }
}
export async function folderOperation(root: string, op: Exclude<ResourceOperation, { kind: "http" }>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (op.kind === "list") {
    const entries = await readdir(await containedPath(root, op.path), { withFileTypes: true });
    return JSON.stringify(entries.slice(0, 2000).map(e => ({ name: e.name, kind: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "link" : "file" })));
  }
  if (op.kind === "read") { const text = await readText(await containedPath(root, op.path)); return JSON.stringify({ text, hash: hash(text) }); }
  if (op.kind === "write") {
    const path = await containedPath(root, op.path, true);
    let previous: string | null = null;
    try { previous = await readText(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if ((previous === null ? null : hash(previous)) !== op.expectedHash) throw new Error("File changed. Read it again before editing.");
    const temporary = join(dirname(path), `.beam-${randomUUID()}.tmp`);
    const mode = previous === null ? 0o600 : (await stat(path)).mode & 0o777;
    await writeFile(temporary, op.text, { flag: "wx", mode }); await rename(temporary, path);
    return JSON.stringify({ hash: hash(op.text) });
  }
  const path = await realpath(root);
  // No host shell, docker socket, home directory, or other host mounts. Installation means project dependencies.
  const name = `beam-resource-${randomUUID()}`;
  try {
    const result = await execute("docker", ["run", "--rm", "--name", name, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--cpus=2", "--network", op.install ? "bridge" : "none", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--env", "HOME=/tmp", "--volume", `${path}:/workspace:rw`, "--workdir", "/workspace", "node:22-bookworm", "sh", "-lc", op.command], { timeout: 60_000, maxBuffer: 200_000, ...(signal ? { signal } : {}) });
    return JSON.stringify({ stdout: result.stdout, stderr: result.stderr, environment: "Isolated container; shared folder mounted at /workspace" });
  } catch (error) {
    await execute("docker", ["rm", "-f", name], { timeout: 5000 }).catch(() => {});
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${e.message.slice(0, 300)}\n${e.stderr?.slice(0, 1000) ?? ""}`);
  }
}
async function serviceOperation(port: number, op: Extract<ResourceOperation, { kind: "http" }>, signal?: AbortSignal) {
  if (!op.path.startsWith("/") || op.path.startsWith("//") || op.path.includes("\\")) throw new Error("Use a relative service path");
  const response = await fetch(`http://127.0.0.1:${port}${op.path}`, { method: op.method, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
  const chunks: Uint8Array[] = []; let size = 0; let more = false;
  if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const start = Math.max(0, op.offset - size); const end = Math.min(chunk.length, op.offset + 450_000 - size);
    if (end > start) chunks.push(chunk.subarray(start, end));
    size += chunk.length;
    if (size >= op.offset + 450_000) { more = true; break; }
  }
  const location = response.headers.get("location")?.replace(`http://127.0.0.1:${port}`, "").replace(`http://localhost:${port}`, "");
  return JSON.stringify({ status: response.status, contentType: response.headers.get("content-type") ?? "application/octet-stream", body: Buffer.concat(chunks).toString("base64"), more, ...(location ? { location } : {}) });
}

export function watchResources(client: ConvexClient, token: string) {
  const active = new Set<string>(); const lanes = new Map<string, Promise<unknown>>();
  return client.onUpdate(api.resources.queued, { token }, requests => {
    for (const request of requests) {
      if (active.has(request._id)) continue; active.add(request._id);
      const previous = lanes.get(request.resourceId) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const claimed = await client.mutation(api.resources.claim, { token, id: request._id }); if (!claimed) return;
        const abort = new AbortController();
        const lease = client.onUpdate(api.resources.lease, { token, id: request._id }, valid => { if (!valid) abort.abort(new Error("Resource permission or run was revoked")); }, () => abort.abort(new Error("Could not verify resource access")));
        try {
          if (!(await client.query(api.resources.lease, { token, id: request._id }))) throw new Error("Resource access revoked");
          const resource = LocalResource.parse(JSON.parse(await readFile(join(localDirectory(), `${claimed.resource.localId}.json`), "utf8")));
          const operation = ResourceOperation.parse(request.operation);
          const result = resource.kind === "folder" && operation.kind !== "http" ? await folderOperation(resource.path, operation, abort.signal) : resource.kind === "service" && operation.kind === "http" ? await serviceOperation(resource.port, operation, abort.signal) : (() => { throw new Error("Operation does not match resource"); })();
          await client.mutation(api.resources.finish, { token, id: request._id, result });
        } catch (e) { await client.mutation(api.resources.finish, { token, id: request._id, error: (e as Error).message }); } finally { lease(); }
      }).catch(e => console.error("Shared resource request failed", (e as Error).message)).finally(() => { active.delete(request._id); if (lanes.get(request.resourceId) === next) lanes.delete(request.resourceId); });
      lanes.set(request.resourceId, next);
    }
  });
}
export async function requestResource(client: ConvexClient, token: string, context: { runId: Id<"runs"> } | { chatId: Id<"chats"> }, resourceId: Id<"workspaceResources">, operation: ResourceOperation) {
  const id = await client.mutation(api.resources.request, { token, ...context, resourceId, operation });
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Resource request timed out; check the host before retrying a command")); }, 90_000);
    const unsubscribe = client.onUpdate(api.resources.result, { token, id }, r => { if (r.state === "done" || r.state === "failed") { clearTimeout(timeout); unsubscribe(); r.state === "done" ? resolve(r.result ?? "") : reject(new Error(r.error ?? "Resource operation failed")); } }, e => { clearTimeout(timeout); unsubscribe(); reject(e); });
  });
}
export function resourceTools(client: ConvexClient, token: string, runId: Id<"runs">): BeamTool[] {
  return [
    { name: "list_shared_resources", description: "List folders and preview services contributed to this workspace by members. Resources stay on their owners' machines; your provider account stays unchanged.", schema: {}, run: async () => JSON.stringify(await client.query(api.resources.forRun, { token, runId })) },
    { name: "use_shared_resource", description: "Operate on a shared folder or preview on its host. list/read/write use relative paths; read returns a hash required for write (null creates a new file). command runs in an isolated Linux container at /workspace, not the host shell; install requires owner opt-in. http reads a preview service. Never retry a timed-out modifying operation without checking its result.", schema: { resourceId: z.string(), operation: ResourceOperation }, run: async a => requestResource(client, token, { runId }, a["resourceId"] as Id<"workspaceResources">, ResourceOperation.parse(a["operation"])) },
  ];
}
