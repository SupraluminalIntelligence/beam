// Write latest-mac.yml for a version from apps/desktop/release, listing every zip and dmg so both
// architectures update from the same feed. electron-builder only writes this when its own publish succeeds.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const version = process.argv[2]; if (!version) { console.error("usage: mac-feed.mjs <version>"); process.exit(1); }
const dir = new URL("../apps/desktop/release", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.startsWith(`Beam-${version}-`) && /\.(zip|dmg)$/.test(f)).sort((a, b) => (a.includes("arm64") ? -1 : 1) - (b.includes("arm64") ? -1 : 1));
const sha = (f) => execFileSync("openssl", ["dgst", "-sha512", "-binary", join(dir, f)]).toString("base64");
const entries = files.map((f) => ({ url: f, sha512: sha(f), size: statSync(join(dir, f)).size }));
const def = entries.find((e) => e.url.endsWith("-mac.zip") && !e.url.includes("arm64")) ?? entries[0];
const yml = `version: ${version}\nfiles:\n${entries.map((e) => `  - url: ${e.url}\n    sha512: ${e.sha512}\n    size: ${e.size}\n`).join("")}path: ${def.url}\nsha512: ${def.sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
writeFileSync(join(dir, "latest-mac.yml"), yml);
console.log(yml);
