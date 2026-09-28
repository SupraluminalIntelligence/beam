import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { publishWindowsRelease, validateWindowsRelease } from "./release-windows.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "beam-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = "Beam-1.2.3-win-x64-setup.exe";
  writeFileSync(join(dir, name), "installer");
  writeFileSync(join(dir, `${name}.blockmap`), "blockmap");
  const sha512 = createHash("sha512").update("installer").digest("base64");
  writeFileSync(join(dir, "latest.yml"), JSON.stringify({ version: "1.2.3", path: name, sha512, files: [{ url: name, size: 9, sha512 }] }));
  const release = { tag_name: "v1.2.3", draft: true, prerelease: false, assets: ["Beam-1.2.3-arm64-mac.zip", "Beam-1.2.3-mac.zip", "Beam-1.2.3-arm64.dmg", "Beam-1.2.3-x64.dmg", "latest-mac.yml"].map((name, id) => ({ name, id, state: "uploaded", size: 10 })) };
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[1] === "view") return JSON.stringify({ tagName: "v1.2.2" });
    if (args[0] === "api") return args[1].includes("/assets/") ? "version: 1.2.3" : JSON.stringify([[release]]);
    if (args[1] === "upload") {
      const data = readFileSync(args[3]);
      release.assets.push({ name: basename(args[3]), state: "uploaded", size: data.length, digest: `sha256:${createHash("sha256").update(data).digest("hex")}` });
    }
    return "";
  };
  return { dir, name, release, calls, gh };
}
test("rejects stale or tampered local feeds before any upload", t => {
  const f = fixture(t);
  assert.equal(validateWindowsRelease(f.dir, "1.2.3").length, 3);
  writeFileSync(join(f.dir, f.name), "tampered");
  assert.throws(() => publishWindowsRelease(f.dir, "1.2.3", f.gh), /SHA-512/);
  assert.equal(f.calls.length, 0);
});
test("never changes a published release or a draft missing macOS", t => {
  const f = fixture(t);
  f.release.draft = false;
  assert.throws(() => publishWindowsRelease(f.dir, "1.2.3", f.gh), /immutable/);
  f.release.draft = true; f.release.assets.pop();
  assert.throws(() => publishWindowsRelease(f.dir, "1.2.3", f.gh), /Missing macOS/);
  assert.ok(f.calls.every(c => c[0] === "api"));
});
test("uploads feed last and publishes only after verifying remote checksums", t => {
  const f = fixture(t);
  publishWindowsRelease(f.dir, "1.2.3", f.gh);
  const writes = f.calls.filter(c => c[0] === "release" && c[1] !== "view");
  assert.deepEqual(writes.map(c => c[1]), ["upload", "upload", "upload", "edit"]);
  assert.equal(basename(writes[2][3]), "latest.yml");
  assert.ok(writes[3].includes("--draft=false"));
});
test("keeps a release draft when an uploaded asset has the wrong checksum", t => {
  const f = fixture(t);
  const gh = args => {
    const result = f.gh(args);
    if (args[1] === "upload") f.release.assets.at(-1).digest = "sha256:bad";
    return result;
  };
  assert.throws(() => publishWindowsRelease(f.dir, "1.2.3", gh), /corrupt/);
  assert.ok(!f.calls.some(c => c[1] === "edit"));
});

test("does not replace a newer release with an older draft", t => {
  const f = fixture(t);
  const gh = args => args[1] === "view" ? JSON.stringify({ tagName: "v1.3.0" }) : f.gh(args);
  assert.throws(() => publishWindowsRelease(f.dir, "1.2.3", gh), /must be newer/);
  assert.ok(!f.calls.some(c => c[1] === "upload" || c[1] === "edit"));
});
