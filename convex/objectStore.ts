import { presign } from "./sigv4";

/**
 * The deployment's object store for large outputs: Cloudflare R2, or anything S3-compatible at
 * R2_ENDPOINT (a local MinIO in tests). Configured with Convex environment variables:
 *
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and optionally R2_ENDPOINT
 *   (default https://<account>.r2.cloudflarestorage.com).
 *
 * Convex only signs URLs here; it never reads or writes an object. The secret never leaves this module:
 * it is not logged and not returned, only used to sign.
 */
export type ObjectStore = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: "auto" };

export function objectStore(env: Record<string, string | undefined> = process.env): ObjectStore | null {
  const value = (name: string) => env[name]?.trim() || undefined;
  const account = value("R2_ACCOUNT_ID"), accessKeyId = value("R2_ACCESS_KEY_ID"), secretAccessKey = value("R2_SECRET_ACCESS_KEY"), bucket = value("R2_BUCKET");
  const endpoint = value("R2_ENDPOINT") ?? (account && /^[a-f0-9]{32}$/i.test(account) ? `https://${account}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  // Path-style addressing (/<bucket>/<key>), which R2 and MinIO both accept.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.pathname !== "/" || url.search) return null;
  return { endpoint: url.origin, bucket, accessKeyId, secretAccessKey, region: "auto" };
}

/** A presigned URL for one request on one object. */
export function signObject(store: ObjectStore, method: "GET" | "PUT" | "POST" | "DELETE", key: string, query: Record<string, string>, expiresSeconds: number) {
  return presign({ method, endpoint: store.endpoint, path: `/${store.bucket}/${key}`, query, accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey, region: store.region, expiresSeconds });
}
