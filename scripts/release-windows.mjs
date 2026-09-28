import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
// Use the updater's YAML parser, so validation reads exactly the feed the client reads.
const yaml = createRequire(require.resolve("electron-updater"))("js-yaml");
const repo = "SupraluminalIntelligence/beam-releases";
const hash = (path, algorithm, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);

export function validateWindowsRelease(dir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable x.y.z version");
  const installer = `Beam-${version}-win-x64-setup.exe`;
  const feed = yaml.load(readFileSync(join(dir, "latest.yml"), "utf8"));
  const checksum = hash(join(dir, installer), "sha512", "base64");
  if (feed.version !== version || feed.path !== installer || feed.sha512 !== checksum ||
      feed.files?.length !== 1 || feed.files[0].url !== installer ||
      feed.files[0].sha512 !== checksum || feed.files[0].size !== statSync(join(dir, installer)).size) {
    throw new Error("Windows update feed does not match the version, installer, size and SHA-512");
  }
  const names = [installer, `${installer}.blockmap`, "latest.yml"];
  for (const name of names) if (!statSync(join(dir, name)).size) throw new Error(`Empty asset: ${name}`);
  return names;
}

export function publishWindowsRelease(dir, version, gh = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true })) {
  const names = validateWindowsRelease(dir, version);
  const tag = `v${version}`;
  const requireNewer = () => {
    const latest = JSON.parse(gh(["release", "view", "--repo", repo, "--json", "tagName"])).tagName;
    if (!/^v\d+\.\d+\.\d+$/.test(latest)) throw new Error(`Unexpected latest release: ${latest}`);
    const previous = latest.slice(1).split(".").map(Number);
    const next = version.split(".").map(Number);
    const firstDifference = next.findIndex((n, i) => n !== previous[i]);
    if (firstDifference < 0 || next[firstDifference] < previous[firstDifference]) throw new Error(`${tag} must be newer than ${latest}`);
  };
  const getRelease = () => JSON.parse(gh(["api", `repos/${repo}/releases`, "--paginate", "--slurp"])).flat().filter(r => r.tag_name === tag);
  const matches = getRelease();
  if (matches.length !== 1 || !matches[0].draft || matches[0].prerelease) throw new Error(`Expected one stable draft release ${tag}; published releases are immutable`);
  const release = matches[0];
  // macOS builds first. Never expose a release missing either platform's updater feed.
  for (const name of [`Beam-${version}-arm64-mac.zip`, `Beam-${version}-mac.zip`, `Beam-${version}-arm64.dmg`, `Beam-${version}-x64.dmg`, "latest-mac.yml"]) {
    if (!release.assets.some(a => a.name === name && a.state === "uploaded" && a.size > 0)) throw new Error(`Missing macOS asset: ${name}`);
  }
  const macFeed = release.assets.find(a => a.name === "latest-mac.yml");
  const mac = yaml.load(gh(["api", `repos/${repo}/releases/assets/${macFeed.id}`, "-H", "Accept: application/octet-stream"]));
  if (mac.version !== version) throw new Error("macOS update feed version does not match");
  requireNewer();
  // Feed last, while still draft. A retry can replace partial uploads safely.
  for (const name of names) gh(["release", "upload", tag, join(dir, name), "--repo", repo, "--clobber"]);
  const uploaded = getRelease();
  if (uploaded.length !== 1 || !uploaded[0].draft) throw new Error("Release changed while uploading");
  for (const name of names) {
    const asset = uploaded[0].assets.find(a => a.name === name);
    const path = join(dir, name);
    if (!asset || asset.state !== "uploaded" || asset.size !== statSync(path).size ||
        asset.digest !== `sha256:${hash(path, "sha256", "hex")}`) throw new Error(`Missing or corrupt uploaded asset: ${name}`);
  }
  requireNewer();
  gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]);
  console.log(`Published ${tag} with verified Windows and macOS assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
  const expected = process.env.BEAM_RELEASE_VERSION;
  if (expected && expected !== version) throw new Error(`Requested ${expected}, checkout is ${version}`);
  const dir = join(root, "apps/desktop/release");
  if (process.argv.includes("--publish")) publishWindowsRelease(dir, version);
  else { validateWindowsRelease(dir, version); console.log(`Verified Windows ${version} installer and update feed`); }
}
