import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const version = process.argv[2];
if (!version) throw new Error("A release version is required");
const dir = fileURLToPath(new URL("../apps/desktop/release/", import.meta.url));
const expected = readdirSync(dir).filter(f => f.startsWith(`Beam-${version}-`) && /\.(zip|dmg)(\.blockmap)?$/.test(f));
for (const name of [`Beam-${version}-arm64-mac.zip`, `Beam-${version}-mac.zip`, `Beam-${version}-arm64.dmg`, `Beam-${version}-x64.dmg`]) {
  if (!expected.includes(name)) throw new Error(`Missing local installer: ${name}`);
}
expected.push("latest-mac.yml");
const { assets } = JSON.parse(execFileSync("gh", ["api", `repos/SupraluminalAI/beam-releases/releases/tags/v${version}`], { encoding: "utf8" }));
for (const name of expected) {
  const asset = assets.find(a => a.name === name);
  if (!asset || asset.state !== "uploaded" || asset.size !== statSync(join(dir, name)).size) throw new Error(`Missing or incomplete release asset: ${name}`);
  if (asset.digest && asset.digest !== `sha256:${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}`) throw new Error(`Release asset checksum mismatch: ${name}`);
}
console.log(`Verified ${expected.length} release assets for ${version}`);
