import { expect, it } from "vitest";
import { completeMultipartXml, LARGE_OUTPUT_PART_BYTES, largeOutputKey, largeOutputReasons, LargeOutputSize, MAX_LARGE_OUTPUT_BYTES, MAX_UPLOAD_PARTS, PartNumbers, planParts, uploadIdFromXml } from "./largeOutputs";

const MiB = 2 ** 20;
it("plans 64 MiB parts with a smaller last part, covering every byte once", () => {
  const size = 3 * LARGE_OUTPUT_PART_BYTES + 12345, parts = planParts(size);
  expect(parts.map(p => p.partNumber)).toEqual([1, 2, 3, 4]);
  expect(parts.map(p => p.length)).toEqual([LARGE_OUTPUT_PART_BYTES, LARGE_OUTPUT_PART_BYTES, LARGE_OUTPUT_PART_BYTES, 12345]);
  expect(parts.every((p, i) => p.offset === i * LARGE_OUTPUT_PART_BYTES)).toBe(true);
  expect(planParts(LARGE_OUTPUT_PART_BYTES)).toEqual([{ partNumber: 1, offset: 0, length: LARGE_OUTPUT_PART_BYTES }]);
  expect(planParts(1)).toEqual([{ partNumber: 1, offset: 0, length: 1 }]);
});
it("keeps the largest allowed output well under S3's 10,000-part limit, and grows parts for anything bigger", () => {
  expect(planParts(MAX_LARGE_OUTPUT_BYTES)).toHaveLength(80);
  const huge = planParts(10_000 * 5 * MiB + 1, 5 * MiB);
  expect(huge.length).toBeLessThanOrEqual(MAX_UPLOAD_PARTS);
  expect(huge[0]!.length % MiB).toBe(0);
  expect(huge.reduce((n, p) => n + p.length, 0)).toBe(10_000 * 5 * MiB + 1);
});
it("refuses sizes and part sizes S3 would reject", () => {
  expect(() => planParts(0)).toThrow("positive");
  expect(() => planParts(1.5)).toThrow("positive");
  expect(() => planParts(100 * MiB, MiB)).toThrow("at least");
});
it("keys outputs by job and path, refusing paths that could escape the job's prefix", () => {
  expect(largeOutputKey("j57abc", "beam/out/fields/part.vtu")).toBe("jobs/j57abc/beam/out/fields/part.vtu");
  expect(() => largeOutputKey("j57abc", "beam/../other/x")).toThrow();
  expect(() => largeOutputKey("../j", "beam/out/x")).toThrow("Invalid job id");
});
it("validates sizes and part numbers at the boundary", () => {
  expect(LargeOutputSize.safeParse(20 * MiB).success).toBe(false);
  expect(LargeOutputSize.safeParse(20 * MiB + 1).success).toBe(true);
  expect(LargeOutputSize.safeParse(MAX_LARGE_OUTPUT_BYTES + 1).success).toBe(false);
  expect(PartNumbers.safeParse([1, 2]).success).toBe(true);
  expect(PartNumbers.safeParse([1, 1]).success).toBe(false);
  expect(PartNumbers.safeParse([0]).success).toBe(false);
  expect(PartNumbers.safeParse([]).success).toBe(false);
});
it("reads the upload ID from S3's XML and writes the completion body with ETags as given", () => {
  expect(uploadIdFromXml(`<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>abc&amp;def</UploadId></InitiateMultipartUploadResult>`)).toBe("abc&def");
  expect(() => uploadIdFromXml("<Error><Code>AccessDenied</Code></Error>")).toThrow("no UploadId");
  expect(completeMultipartXml([{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }]))
    .toBe('<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>');
});
it("says why a large file stayed where it was written", () => {
  expect(largeOutputReasons.notConfigured()).toBe("larger than 20 MB; kept on the machine, since large-output storage is not configured");
  expect(largeOutputReasons.tooLarge()).toBe("larger than 5 GiB; kept on the machine");
  expect(largeOutputReasons.jobTotal()).toBe("past this job's 20 GiB of large outputs; kept on the machine");
  expect(largeOutputReasons.refused(403)).toBe("larger than 20 MB; kept on the machine, since large-output storage refused the upload (HTTP 403)");
});
