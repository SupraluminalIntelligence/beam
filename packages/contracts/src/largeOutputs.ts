import { z } from "zod";
import { JobPath, MAX_COMPUTE_FILE_BYTES } from "./compute.ts";

/**
 * Large outputs: a result file over MAX_COMPUTE_FILE_BYTES goes to an S3-compatible object store
 * (Cloudflare R2 in production) instead of Convex storage, when the deployment has one configured.
 * Convex only signs URLs; the machine that holds the file uploads it in parts, and a viewer downloads
 * it with a short-lived signed link.
 */
const GiB = 2 ** 30, MiB = 2 ** 20;
/** The largest single output kept in the object store. */
export const MAX_LARGE_OUTPUT_BYTES = 5 * GiB;
/** The most one job may keep in the object store, all its large outputs together. */
export const MAX_JOB_LARGE_OUTPUT_BYTES = 20 * GiB;
/** Uploads go in parts of this size; the last part is smaller. */
export const LARGE_OUTPUT_PART_BYTES = 64 * MiB;
/** S3 and R2: at most 10,000 parts, each at least 5 MiB except the last. */
export const MAX_UPLOAD_PARTS = 10_000;
export const MIN_UPLOAD_PART_BYTES = 5 * MiB;
/** Signed part and completion URLs are requested in batches of at most this many parts. */
export const MAX_PART_URLS = 16;

export type UploadPart = { partNumber: number; offset: number; length: number };
/**
 * The parts a file of `size` bytes uploads in: `partBytes` each (raised, in whole MiB, if the file would
 * otherwise need more than 10,000 parts), the last one smaller.
 */
export function planParts(size: number, partBytes = LARGE_OUTPUT_PART_BYTES): UploadPart[] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("A multipart upload needs a positive whole number of bytes");
  if (!Number.isSafeInteger(partBytes) || partBytes < MIN_UPLOAD_PART_BYTES) throw new Error(`Upload parts must be at least ${MIN_UPLOAD_PART_BYTES} bytes`);
  const each = Math.max(partBytes, Math.ceil(size / MAX_UPLOAD_PARTS / MiB) * MiB);
  const parts: UploadPart[] = [];
  for (let offset = 0, n = 1; offset < size; offset += each, n++) parts.push({ partNumber: n, offset, length: Math.min(each, size - offset) });
  return parts;
}

/** Where a job's output lives in the bucket. The path is a JobPath, so it has no empty, dot or parent segments. */
export const largeOutputKey = (jobId: string, path: string) => {
  if (!/^[\w-]+$/.test(jobId)) throw new Error("Invalid job id");
  return `jobs/${jobId}/${JobPath.parse(path)}`;
};

/** Why a file over the Convex limit stayed where it was written. Shown beside the file in Results. */
const over = `larger than ${MAX_COMPUTE_FILE_BYTES / MiB} MB`;
export const largeOutputReasons = {
  notConfigured: (where = "kept on the machine") => `${over}; ${where}, since large-output storage is not configured`,
  tooLarge: (where = "kept on the machine") => `larger than ${MAX_LARGE_OUTPUT_BYTES / GiB} GiB; ${where}`,
  jobTotal: (where = "kept on the machine") => `past this job's ${MAX_JOB_LARGE_OUTPUT_BYTES / GiB} GiB of large outputs; ${where}`,
  refused: (status: number, where = "kept on the machine") => `${over}; ${where}, since large-output storage refused the upload (HTTP ${status})`,
  notFile: (where = "kept on the machine") => `not a regular file; ${where}`,
};

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Use a lowercase hex SHA-256");
/** An S3 multipart upload ID, as the store returned it. */
export const UploadId = z.string().min(1).max(1024).refine(v => !/[\x00-\x1f]/.test(v), "Invalid upload ID");
export const LargeOutputSize = z.number().int().gt(MAX_COMPUTE_FILE_BYTES).lte(MAX_LARGE_OUTPUT_BYTES);
export const PartNumbers = z.array(z.number().int().min(1).max(MAX_UPLOAD_PARTS)).min(1).max(MAX_PART_URLS)
  .refine(parts => new Set(parts).size === parts.length, "Duplicate part numbers");

/** What the runner learns when it asks to upload a large output. */
export type LargeOutputStart =
  | { ok: true; key: string; partBytes: number; createUrl: string }
  | { ok: false; reason: string };
export type LargeOutputUrls = { parts: { partNumber: number; url: string }[]; completeUrl: string; abortUrl: string };

/** The body S3's CompleteMultipartUpload expects. ETags are passed through exactly as the store sent them. */
export function completeMultipartXml(parts: { partNumber: number; etag: string }[]): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escape(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
}
/** The UploadId in a CreateMultipartUpload response. */
export function uploadIdFromXml(xml: string): string {
  const match = /<UploadId>([^<]+)<\/UploadId>/.exec(xml);
  if (!match) throw new Error("The store's CreateMultipartUpload response has no UploadId");
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return UploadId.parse(unescape(match[1]!));
}
