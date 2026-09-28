import { expect, it } from "vitest";
import { presign, uriEncode } from "./sigv4";

// AWS's published example: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
const example = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") };
it("matches AWS's published presigned GET example", async () => {
  const url = await presign({ ...example, method: "GET", endpoint: "https://examplebucket.s3.amazonaws.com", path: "/test.txt", expiresSeconds: 86400 });
  expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

// Generated with botocore 1.38 (generate_presigned_url, path-style, region auto, clock fixed at 2026-09-27T12:00:00Z).
const minio = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret/Key+Example", region: "auto", endpoint: "http://localhost:9000", now: new Date("2026-09-27T12:00:00Z") };
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);
it("matches botocore for a multipart part on a path-style endpoint with a port and an awkward key", async () => {
  const url = await presign({ ...minio, method: "PUT", path: "/beam/jobs/j1/beam/out/fields/big file+(1).vtu", query: { partNumber: "3", uploadId: "abc/def==" }, expiresSeconds: 3600 });
  expect(url.split("?")[0]).toBe("http://localhost:9000/beam/jobs/j1/beam/out/fields/big%20file%2B%281%29.vtu");
  expect(params(url)).toMatchObject({ partNumber: "3", uploadId: "abc/def==", "X-Amz-Signature": "7c2d7ce36144fa26d7b78a2c92a3782010a0d0a753ff0afae45e4bbaaad43c7a" });
});
it("matches botocore for CreateMultipartUpload's bare ?uploads flag", async () => {
  const url = await presign({ ...minio, method: "POST", path: "/beam/jobs/j1/beam/out/a.bin", query: { uploads: "" }, expiresSeconds: 900 });
  expect(url).toContain("?X-Amz-Algorithm=AWS4-HMAC-SHA256&");
  expect(url).toContain("&uploads=&");
  expect(params(url)["X-Amz-Signature"]).toBe("8240c9c85e9d88de5595ba0b498833875743779d60e271beec647cfafee03a46");
});
it("encodes reserved characters and refuses malformed requests", async () => {
  expect(uriEncode("a b+c/(d)*!'~._-")).toBe("a%20b%2Bc%2F%28d%29%2A%21%27~._-");
  await expect(presign({ ...minio, method: "GET", path: "/b/k", expiresSeconds: 0 })).rejects.toThrow("7 days");
  await expect(presign({ ...minio, method: "GET", path: "b/k", expiresSeconds: 60 })).rejects.toThrow("start with /");
  await expect(presign({ ...minio, endpoint: "http://localhost:9000/bucket", method: "GET", path: "/b/k", expiresSeconds: 60 })).rejects.toThrow("no path");
});
