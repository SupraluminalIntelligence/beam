import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { ConvexClient } from "convex/browser";
import type { LargeOutputPublisher } from "@beam/compute";
import { completeMultipartXml, largeOutputReasons, MAX_LARGE_OUTPUT_BYTES, planParts, previewLengthMismatch, ResultRejected, RESULTS_ROOT, uploadIdFromXml, type ComputeExecutor } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";

/**
 * Uploads a result file over the Convex storage limit to the large-output store (R2), straight from
 * this computer's disk: Convex signs each request, and the file is read one part at a time, so a
 * multi-GB file is never held in memory. Its SHA-256 is computed on the way.
 */

/** The store refused a request outright (credentials, bucket, a malformed part): retrying will not help. */
class StoreRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type LargeOutputOptions = { retryDelayMs?: number; log?: (line: string) => void };

async function send(url: string, init: RequestInit, what: string, retryDelayMs: number): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15 * 60_000) });
      if (response.ok) return response;
      const code = /<Code>([^<]+)<\/Code>/.exec(await response.text().catch(() => ""))?.[1];
      const message = `${what}: HTTP ${response.status}${code ? ` ${code}` : ""}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new StoreRefused(response.status, message);
      last = new Error(message);
    } catch (e) {
      if (e instanceof StoreRefused) throw e;
      last = e;
    }
  }
  throw last;
}

/** A publisher for executors that keep outputs on this computer's disk; none for others. */
export function largeOutputPublisher(client: ConvexClient, token: string, executor: ComputeExecutor, options: LargeOutputOptions = {}): LargeOutputPublisher | undefined {
  if (!executor.localPath) return undefined;
  const localPath = executor.localPath.bind(executor), retryDelayMs = options.retryDelayMs ?? 1000, log = options.log ?? (line => console.log(line));
  return async (handle, jobId, path, expectedBytes) => {
    const file = await localPath(handle, path), meta = await stat(file);
    if (!meta.isFile()) return { published: false, reason: largeOutputReasons.notFile() };
    if (expectedBytes !== undefined && meta.size !== expectedBytes) throw new ResultRejected(previewLengthMismatch(path.slice(RESULTS_ROOT.length + 1), meta.size, expectedBytes));
    if (meta.size > MAX_LARGE_OUTPUT_BYTES) return { published: false, reason: largeOutputReasons.tooLarge() };
    const args = { token, id: jobId, path, size: meta.size };
    const start = await client.action(api.compute.startLargeOutput, args);
    if (!start.ok) return { published: false, reason: start.reason };
    const parts = planParts(meta.size, start.partBytes);
    log(`compute: uploading ${path} (${meta.size} bytes, ${parts.length} parts) to large-output storage`);
    let uploadId: string;
    try { uploadId = uploadIdFromXml(await (await send(start.createUrl, { method: "POST" }, "Starting the upload", retryDelayMs)).text()); }
    catch (e) { if (e instanceof StoreRefused) return { published: false, reason: largeOutputReasons.refused(e.status) }; throw e; }
    const urls = (partNumber: number) => client.action(api.compute.largeOutputUrls, { ...args, uploadId, parts: [partNumber] });
    let abortUrl: string | null = null, completed = false;
    try {
      const hash = createHash("sha256"), etags: { partNumber: number; etag: string }[] = [];
      const buffer = Buffer.allocUnsafe(parts[0]!.length);
      let completeUrl = "";
      const handleFile = await open(file, "r");
      try {
        for (const part of parts) {
          const chunk = buffer.subarray(0, part.length);
          for (let filled = 0; filled < part.length;) {
            const { bytesRead } = await handleFile.read(chunk, filled, part.length - filled, part.offset + filled);
            if (!bytesRead) throw new Error(`${path} changed while it was uploading`);
            filled += bytesRead;
          }
          hash.update(chunk);
          // Signed just before use, so a slow link never outlives a URL.
          const signed = await urls(part.partNumber);
          abortUrl = signed.abortUrl; completeUrl = signed.completeUrl;
          const response = await send(signed.parts[0]!.url, { method: "PUT", body: chunk }, `Uploading part ${part.partNumber} of ${parts.length}`, retryDelayMs);
          const etag = response.headers.get("etag");
          if (!etag) throw new Error("The store returned no ETag for a part");
          etags.push({ partNumber: part.partNumber, etag });
        }
      } finally { await handleFile.close(); }
      const done = await send(completeUrl, { method: "POST", headers: { "Content-Type": "application/xml" }, body: completeMultipartXml(etags) }, "Completing the upload", retryDelayMs);
      // CompleteMultipartUpload can answer 200 with an error in its body.
      const body = await done.text(), code = /<Error>[\s\S]*?<Code>([^<]+)<\/Code>/.exec(body)?.[1];
      if (code) throw new Error(`Completing the upload: ${code}`);
      completed = true;
      await client.action(api.compute.recordLargeOutput, { ...args, sha256: hash.digest("hex"), key: start.key });
      log(`compute: published ${path} to large-output storage`);
      return { published: true };
    } catch (e) {
      // An unfinished upload is aborted so its parts stop costing storage; a completed one is kept, and
      // the next pass uploads it again under the same key before recording it.
      if (!completed) {
        abortUrl ??= await urls(1).then(u => u.abortUrl, () => null);
        if (abortUrl) await fetch(abortUrl, { method: "DELETE", signal: AbortSignal.timeout(30_000) }).catch(() => {});
      }
      if (e instanceof StoreRefused) return { published: false, reason: largeOutputReasons.refused(e.status) };
      throw e;
    }
  };
}
