/**
 * AWS Signature Version 4, query-string form: a presigned URL for one S3 request. Pure, and only Web
 * Crypto, so it runs in the Convex runtime, in Node and in tests alike. The payload is never signed
 * (UNSIGNED-PAYLOAD), so the holder of a URL can send any body for that one method and object until it
 * expires; only the host header is signed.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */
export type Presign = {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  /** Scheme, host and optional port, e.g. https://<account>.r2.cloudflarestorage.com. No path. */
  endpoint: string;
  /** The object's path as S3 sees it, unencoded, starting with "/" (path-style: /<bucket>/<key>). */
  path: string;
  /** Operation parameters such as uploads, partNumber or uploadId. An empty string is a bare flag (?uploads). */
  query?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  expiresSeconds: number;
  now?: Date;
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
async function hmac(key: BufferSource, text: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(text));
}
/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~ is percent-encoded. */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function presign(p: Presign): Promise<string> {
  if (!Number.isInteger(p.expiresSeconds) || p.expiresSeconds < 1 || p.expiresSeconds > 604_800) throw new Error("Presigned URLs last 1 second to 7 days");
  if (!p.path.startsWith("/")) throw new Error("The path must start with /");
  const endpoint = new URL(p.endpoint);
  if (endpoint.pathname !== "/" || endpoint.search) throw new Error("The endpoint has no path or query");
  const service = p.service ?? "s3";
  const amzDate = (p.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8), scope = `${day}/${p.region}/${service}/aws4_request`;
  const params: [string, string][] = [
    ...Object.entries(p.query ?? {}),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${p.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(p.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = params.map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join("&");
  const uri = p.path.split("/").map(uriEncode).join("/");
  const canonical = [p.method, uri, query, `host:${endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key: BufferSource = encoder.encode(`AWS4${p.secretAccessKey}`);
  for (const part of [day, p.region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `${endpoint.origin}${uri}?${query}&X-Amz-Signature=${signature}`;
}
