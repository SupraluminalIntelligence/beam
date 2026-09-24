import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedPath, folderOperation } from "./resources";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "beam-resource-")); roots.push(root); const shared = join(root, "shared"); await mkdir(shared); return { root, shared }; }
it("rejects traversal, absolute paths and symlinks escaping a contributed folder", async () => {
  const { root, shared } = await fixture(); await writeFile(join(root, "private"), "private"); await symlink(root, join(shared, "escape"));
  await expect(containedPath(shared, "../private")).rejects.toThrow("leaves");
  await expect(containedPath(shared, join(root, "private"))).rejects.toThrow("relative");
  await expect(containedPath(shared, "escape/private")).rejects.toThrow("leaves");
  await expect(containedPath(shared, "escape/new", true)).rejects.toThrow("leaves");
});
it("requires an up-to-date read hash before modifying a shared file", async () => {
  const { shared } = await fixture(); await writeFile(join(shared, "page.txt"), "first");
  const read = JSON.parse(await folderOperation(shared, { kind: "read", path: "page.txt" }));
  expect(read.text).toBe("first");
  await writeFile(join(shared, "page.txt"), "someone else's edit");
  await expect(folderOperation(shared, { kind: "write", path: "page.txt", text: "overwrite", expectedHash: read.hash })).rejects.toThrow("File changed");
  const current = JSON.parse(await folderOperation(shared, { kind: "read", path: "page.txt" }));
  await folderOperation(shared, { kind: "write", path: "page.txt", text: "merged", expectedHash: current.hash });
  expect(await readFile(join(shared, "page.txt"), "utf8")).toBe("merged");
  await folderOperation(shared, { kind: "write", path: "new.txt", text: "new", expectedHash: null });
  await expect(folderOperation(shared, { kind: "write", path: "new.txt", text: "again", expectedHash: null })).rejects.toThrow("File changed");
});
it("does not execute an operation after permission is revoked", async () => {
  const { shared } = await fixture(); const abort = new AbortController(); abort.abort(new Error("revoked"));
  await expect(folderOperation(shared, { kind: "write", path: "new.txt", text: "new", expectedHash: null }, abort.signal)).rejects.toThrow("revoked");
});

it.runIf(process.env["BEAM_RESOURCE_CONTAINER_TEST"] === "1")("runs project commands inside a real container without exposing sibling host files", async () => {
  const { root, shared } = await fixture();
  await writeFile(join(root, "private.txt"), "outside resource");
  const result = JSON.parse(await folderOperation(shared, { kind: "command", install: false, command: "test ! -e /var/run/docker.sock && test ! -e /workspace/../private.txt && printf inside > result.txt" }));
  expect(result.environment).toContain("Isolated container");
  expect(await readFile(join(shared, "result.txt"), "utf8")).toBe("inside");
}, 90_000);
