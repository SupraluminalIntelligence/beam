#!/usr/bin/env node
// Check a large-output bucket end to end with Beam's own signer (convex/sigv4.ts): a multipart upload
// in the parts the runner uses, a presigned download compared by SHA-256, an aborted upload, and cleanup.
// It reads the same variables Convex does, from this shell; set them for this command only:
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
//     node --experimental-strip-types scripts/r2-check.mjs [--mb 70] [--create-bucket]
//
// R2_ENDPOINT points it at another S3-compatible store (a local MinIO: http://127.0.0.1:9000), and
// --create-bucket creates the bucket first, for such a throwaway store. It never prints a secret.
import { createHash, randomBytes } from "node:crypto";
import { presign } from "../convex/sigv4.ts";
import { completeMultipartXml, LARGE_OUTPUT_PART_BYTES, planParts, uploadIdFromXml } from "../packages/contracts/src/largeOutputs.ts";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const env = name => process.env[name]?.trim() || undefined;
const account = env("R2_ACCOUNT_ID"), bucket = env("R2_BUCKET"), accessKeyId = env("R2_ACCESS_KEY_ID"), secretAccessKey = env("R2_SECRET_ACCESS_KEY");
const endpoint = env("R2_ENDPOINT") ?? (account ? `https://${account}.r2.cloudflarestorage.com` : undefined);
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) { console.error("Set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET."); process.exit(1); }
const sign = (method, path, query = {}, expiresSeconds = 900) => presign({ method, endpoint, path, query, accessKeyId, secretAccessKey, region: "auto", expiresSeconds });
const redact = url => url.replace(/X-Amz-Signature=\w+/, "X-Amz-Signature=…").replace(/X-Amz-Credential=[^&]+/, "X-Amz-Credential=…");
// As the runner does: a dropped connection (a reused keep-alive socket the store has closed) is retried
// up to three times; a refusal is not.
async function send(method, url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try { response = await fetch(url, { method, ...init }); }
    catch (e) { if (attempt === 3) throw e; step(`retrying ${method} after ${e.cause?.code ?? e.message}`); await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
    if (!response.ok) throw new Error(`${method} ${redact(url)}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response;
  }
}
const step = (text) => console.log(`- ${text}`);

const size = Math.round(Number(arg("--mb", "70")) * 2 ** 20);
const key = `checks/r2-check-${Date.now()}/beam/out/fields/big file (1).bin`, objectPath = `/${bucket}/${key}`;
console.log(`Endpoint ${endpoint}, bucket ${bucket}, ${size} bytes`);
if (process.argv.includes("--create-bucket")) { await send("PUT", await sign("PUT", `/${bucket}`)); step(`created bucket ${bucket}`); }

const data = randomBytes(size), sha256 = createHash("sha256").update(data).digest("hex");
const parts = planParts(size, LARGE_OUTPUT_PART_BYTES);
const uploadId = uploadIdFromXml(await (await send("POST", await sign("POST", objectPath, { uploads: "" }))).text());
step(`CreateMultipartUpload: ${parts.length} parts of up to ${LARGE_OUTPUT_PART_BYTES} bytes`);
const etags = [];
for (const part of parts) {
  const response = await send("PUT", await sign("PUT", objectPath, { partNumber: String(part.partNumber), uploadId }), { body: data.subarray(part.offset, part.offset + part.length) });
  etags.push({ partNumber: part.partNumber, etag: response.headers.get("etag") });
  step(`UploadPart ${part.partNumber}: ${part.length} bytes, ETag ${response.headers.get("etag")}`);
}
const completed = await (await send("POST", await sign("POST", objectPath, { uploadId }), { headers: { "Content-Type": "application/xml" }, body: completeMultipartXml(etags) })).text();
if (/<Error>/.test(completed)) throw new Error(`CompleteMultipartUpload: ${completed.slice(0, 300)}`);
step("CompleteMultipartUpload");

const download = await send("GET", await sign("GET", objectPath, { "response-content-disposition": 'attachment; filename="big_file_1_.bin"' }));
const got = Buffer.from(await download.arrayBuffer()), gotSha = createHash("sha256").update(got).digest("hex");
step(`presigned GET: ${got.length} bytes, Content-Disposition ${download.headers.get("content-disposition")}`);
console.log(`  uploaded sha256   ${sha256}\n  downloaded sha256 ${gotSha}`);
if (got.length !== size || gotSha !== sha256) throw new Error("The downloaded object differs from the upload");

const expired = await fetch(await sign("GET", objectPath, {}, 1).then(u => new Promise(r => setTimeout(() => r(u), 2500))));
step(`an expired link is refused: HTTP ${expired.status}`);
if (expired.ok) throw new Error("An expired link still downloads");
const tampered = await fetch((await sign("GET", objectPath)).replace(/big%20file/, "other%20file"));
step(`a link changed to another key is refused: HTTP ${tampered.status}`);
if (tampered.ok) throw new Error("A tampered link still downloads");

const abortId = uploadIdFromXml(await (await send("POST", await sign("POST", `${objectPath}.aborted`, { uploads: "" }))).text());
await send("PUT", await sign("PUT", `${objectPath}.aborted`, { partNumber: "1", uploadId: abortId }), { body: data.subarray(0, 5 * 2 ** 20) });
await send("DELETE", await sign("DELETE", `${objectPath}.aborted`, { uploadId: abortId }));
step("AbortMultipartUpload of a second upload");

await send("DELETE", await sign("DELETE", objectPath));
step("deleted the test object");
console.log("OK: the bucket accepts Beam's signed multipart uploads and downloads.");
