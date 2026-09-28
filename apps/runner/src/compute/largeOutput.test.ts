import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";
import { largeOutputKey, largeOutputReasons, MAX_COMPUTE_FILE_BYTES } from "@beam/contracts";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { reconcileJob } from "./watch";
import { LocalExecutor } from "./local";
import { largeOutputPublisher } from "./largeOutput";

/**
 * A fake S3 that speaks just enough of the multipart protocol (create, upload part, complete, abort, get)
 * and a fake Convex upload endpoint, so the runner's whole publication path runs over real HTTP.
 */
type Upload = { key: string; parts: Map<number, Buffer> };
const s3 = {
  uploads: new Map<string, Upload>(), objects: new Map<string, Buffer>(), aborted: [] as string[], convex: [] as number[],
  failPart: null as number | null, refuseCreate: false, log: [] as string[],
};
let server: Server, base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://s3.test"), key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks), q = url.searchParams;
      s3.log.push(`${req.method} ${q.has("uploads") ? "create" : q.has("partNumber") ? `part ${q.get("partNumber")}` : q.has("uploadId") ? (req.method === "DELETE" ? "abort" : "complete") : url.pathname}`);
      if (url.pathname === "/convex-upload") { s3.convex.push(body.length); res.end(JSON.stringify({ storageId: `blob-${s3.convex.length}` })); return; }
      if (req.method === "POST" && q.has("uploads")) {
        if (s3.refuseCreate) { res.statusCode = 403; res.end("<Error><Code>AccessDenied</Code></Error>"); return; }
        const id = `upload-${s3.uploads.size + 1}`; s3.uploads.set(id, { key, parts: new Map() });
        res.end(`<?xml version="1.0"?><InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      const upload = s3.uploads.get(q.get("uploadId") ?? "");
      if (req.method === "PUT" && upload) {
        const n = Number(q.get("partNumber"));
        if (n === s3.failPart) { res.statusCode = 503; res.end("<Error><Code>SlowDown</Code></Error>"); return; }
        upload.parts.set(n, body); res.setHeader("ETag", `"${createHash("md5").update(body).digest("hex")}"`); res.end(); return;
      }
      if (req.method === "POST" && upload) {
        const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;(\w+)&quot;<\/ETag>/g)];
        const ok = listed.every(([, n, etag]) => createHash("md5").update(upload.parts.get(Number(n)) ?? Buffer.alloc(0)).digest("hex") === etag);
        if (!ok || listed.length !== upload.parts.size) { res.end("<Error><Code>InvalidPart</Code></Error>"); return; }
        s3.objects.set(upload.key, Buffer.concat(listed.map(([, n]) => upload.parts.get(Number(n))!)));
        s3.uploads.delete(q.get("uploadId")!); res.end("<CompleteMultipartUploadResult/>"); return;
      }
      if (req.method === "DELETE" && upload) { s3.aborted.push(q.get("uploadId")!); s3.uploads.delete(q.get("uploadId")!); res.statusCode = 204; res.end(); return; }
      res.statusCode = 404; res.end("<Error><Code>NoSuchUpload</Code></Error>");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const MiB = 2 ** 20;
let home = "";
beforeEach(async () => {
  Object.assign(s3, { uploads: new Map(), objects: new Map(), aborted: [], convex: [], failPart: null, refuseCreate: false, log: [] });
  if (home) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "beam-large-"));
});
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }); });

/** A local environment job that wrote a manifest, a small series and a file over the Convex limit. */
async function setup(options: { configured?: boolean; bigBytes?: number; preview?: boolean } = {}) {
  const work = join(home, "job", "work", "beam", "out");
  await mkdir(join(work, "series"), { recursive: true }); await mkdir(join(work, "fields"), { recursive: true }); await mkdir(join(work, "preview"), { recursive: true });
  const big = Buffer.alloc(options.bigBytes ?? MAX_COMPUTE_FILE_BYTES + 3 * MiB + 17);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
  const manifest = options.preview
    ? { version: 1, fields: [{ name: "p", label: "p", full: "fields/p.vtu", preview: "preview/p.json", cells: 1, arrays: [] }] }
    : { version: 1, series: [{ name: "s", label: "s", data: "series/s.json", points: 1, x: { label: "x" }, y: { lines: ["a"] } }], files: [{ path: "fields/big.bin", label: "big", kind: "file", bytes: big.length }] };
  await writeFile(join(work, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(work, "series", "s.json"), JSON.stringify({ x: [1], lines: [{ name: "a", values: [2] }] }));
  await writeFile(join(work, "fields", "big.bin"), big);
  if (options.preview) {
    // A preview whose positions buffer is over the limit, but not the length the preview says.
    await writeFile(join(work, "fields", "p.vtu"), "x");
    await writeFile(join(work, "preview", "p.json"), JSON.stringify({ version: 1, kind: "surface", vertices: 2_000_000, triangles: 1, positions: "preview/p.positions.f32", indices: "preview/p.indices.u32", arrays: [] }));
    await writeFile(join(work, "preview", "p.positions.f32"), big);
    await writeFile(join(work, "preview", "p.indices.u32"), Buffer.alloc(12));
  }
  const job = { _id: "job", state: "publishing", backend: "local-process", log: "", exitCode: 0, handle: { backend: "local-process", id: "job" }, spec: { version: 1, kind: "environment", title: "Env", environment: { name: "fea", image: "ghcr.io/x/y@sha256:" + "a".repeat(64) }, command: "true", inputs: [], machine: "local", timeoutSeconds: 60 } } as unknown as Doc<"computeJobs">;
  const published = new Set<string>(), recorded: Record<string, unknown>[] = [], calls: string[] = [];
  let results: Record<string, unknown> | null = null;
  const client = {
    query: async (ref: never, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      if (name === "compute:pending") return [job];
      if (name === "compute:hasOutput") return published.has(String(args["path"]));
      throw new Error(name);
    },
    mutation: async (ref: never, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      if (name === "compute:report") { Object.assign(job, args); return; }
      if (name === "compute:outputUploadUrl") return `${base}/convex-upload`;
      if (name === "compute:publishOutput") { published.add(String(args["path"])); return; }
      if (name === "compute:publishResults") { results = args; return; }
      throw new Error(name);
    },
    action: async (ref: never, args: Record<string, unknown>) => {
      const name = getFunctionName(ref), key = largeOutputKey("job", String(args["path"])), at = `${base}/bucket/${key}`;
      calls.push(name);
      if (name === "compute:startLargeOutput") return options.configured === false ? { ok: false, reason: largeOutputReasons.notConfigured() } : { ok: true, key, partBytes: 5 * MiB, createUrl: `${at}?uploads=` };
      if (name === "compute:largeOutputUrls") {
        const id = String(args["uploadId"]);
        return { parts: (args["parts"] as number[]).map(n => ({ partNumber: n, url: `${at}?partNumber=${n}&uploadId=${id}` })), completeUrl: `${at}?uploadId=${id}`, abortUrl: `${at}?uploadId=${id}` };
      }
      if (name === "compute:recordLargeOutput") { recorded.push(args); published.add(String(args["path"])); return "object"; }
      throw new Error(name);
    },
  };
  const executor = new LocalExecutor(home);
  const large = largeOutputPublisher(client as unknown as ConvexClient, "token", executor, { retryDelayMs: 1, log: () => {} })!;
  return { job, big, published, recorded, calls, results: () => results, run: () => reconcileJob(client as unknown as ConvexClient, "token", executor, job, { large }) };
}

it("streams a file over the Convex limit to the object store in parts, then records its size and hash", async () => {
  const s = await setup();
  await s.run();
  expect(s.job.state).toBe("succeeded");
  const key = "jobs/job/beam/out/fields/big.bin";
  expect(s3.objects.get(key)?.equals(s.big)).toBe(true);
  expect(s3.log.filter(l => l.includes("part")).length).toBe(5);
  expect(s.recorded).toEqual([{ token: "token", id: "job", path: "beam/out/fields/big.bin", size: s.big.length, sha256: createHash("sha256").update(s.big).digest("hex"), key }]);
  // The small files still go to Convex storage; nothing is listed as kept on the machine.
  expect(s3.convex.length).toBe(2);
  expect(s.results()).toMatchObject({ unpublished: [] });
});

it("keeps the file on the machine, saying why, when large-output storage is not configured", async () => {
  const s = await setup({ configured: false });
  await s.run();
  expect(s.job.state).toBe("succeeded");
  expect(s.results()).toMatchObject({ unpublished: [{ path: "beam/out/fields/big.bin", reason: "larger than 20 MB; kept on the machine, since large-output storage is not configured" }] });
  expect(s3.log.some(l => l.includes("create"))).toBe(false);
});

it("aborts a failed upload, retries on the next pass, and does not upload a recorded file again", async () => {
  const s = await setup();
  s3.failPart = 3;
  await expect(s.run()).rejects.toThrow("Uploading part 3 of 5: HTTP 503 SlowDown");
  expect(s.job.state).toBe("publishing");
  expect(s3.aborted).toEqual(["upload-1"]);
  expect(s.recorded).toEqual([]);
  s3.failPart = null;
  await s.run();
  expect(s.job.state).toBe("succeeded");
  expect(s.recorded).toHaveLength(1);
  expect(s3.objects.get("jobs/job/beam/out/fields/big.bin")?.equals(s.big)).toBe(true);
  // After a restart mid-publication, the recorded output is skipped.
  s.job.state = "publishing"; s3.log.length = 0; s.calls.length = 0;
  await s.run();
  expect(s.calls).toEqual([]);
  expect(s3.log.filter(l => !l.includes("convex-upload"))).toEqual([]);
});

it("keeps the file when the store refuses the upload outright, rather than retrying forever", async () => {
  const s = await setup();
  s3.refuseCreate = true;
  await s.run();
  expect(s.job.state).toBe("succeeded");
  expect(s.results()).toMatchObject({ unpublished: [{ path: "beam/out/fields/big.bin", reason: "larger than 20 MB; kept on the machine, since large-output storage refused the upload (HTTP 403)" }] });
});

it("fails the job when a large preview buffer is not the length its preview says", async () => {
  const s = await setup({ preview: true });
  await s.run();
  expect(s.job.state).toBe("failed");
  expect(s.job.error).toContain("preview/p.positions.f32 is 24117265 bytes; its preview says 24000000");
  expect(s.calls).not.toContain("compute:startLargeOutput");
});
