// Real NSIS upgrade, with a unique installation identity and temporary profile.
// Requires apps/desktop/dist to be built. Never publishes or pairs a real runner.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

if (process.platform !== "win32") throw new Error("Run this test on Windows");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(root, "apps/desktop");
const require = createRequire(join(project, "package.json"));
const builderRequire = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const reuse = process.argv[2];
const temp = reuse ? resolve(reuse) : mkdtempSync(join(tmpdir(), "beam-upgrade-"));
if (!temp.toLowerCase().startsWith((resolve(tmpdir()) + sep).toLowerCase()) || !basename(temp).startsWith("beam-upgrade-")) throw new Error("Fixtures must be in a beam-upgrade-* temporary directory");
console.log(`Isolated upgrade test: ${temp}`);
const id = reuse ? JSON.parse(readFileSync(join(temp, "config-0.0.1.json"), "utf8")).nsis.guid : randomUUID();
if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid fixture identity");
const name = `beam-update-smoke-${id}`;
const installDir = join(temp, "installed");
const executable = join(installDir, "Beam Update Smoke.exe");
const original = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
const assets = new Map();
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.startsWith("/runner/device/")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(path.endsWith("/start") ? { deviceCode: "smoke", userCode: "UPDATE-TEST", verifyUrl: "http://localhost" } : { status: "pending" }));
    return;
  }
  const file = assets.get(basename(path));
  if (!file) { res.writeHead(404); res.end(); return; }
  const size = statSync(file).size;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
    if (start > end || end >= size) { res.writeHead(416); res.end(); return; }
    res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-length": size });
    createReadStream(file).pipe(res);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, npm_config_user_agent: "pnpm/10.29.1", BEAM_HOME: join(temp, "runner"), BEAM_CONVEX_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const run = (bin, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { cwd: project, env, windowsHide: true, stdio: "inherit", ...options });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${basename(bin)} exited ${code}`)));
});
const waitUntil = async (predicate, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
};
function installedVersion() {
  try { return JSON.parse(asar.extractFile(join(installDir, "resources/app.asar"), "package.json")).version; }
  catch { return null; }
}
// Limit cleanup to the executable under this test's newly allocated directory.
function stopTestWindows() {
  const quoted = executable.replace(/'/g, "''");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: "ignore" });
}
let desktop;
let passed = false;
try {
  for (const version of ["0.0.1", "0.0.2"]) {
    const out = join(temp, version);
    const config = {
      ...original.build, appId: `ai.supraluminal.beam.smoke.${id}`, productName: "Beam Update Smoke",
      executableName: "Beam Update Smoke",
      directories: { ...original.build.directories, output: out },
      extraMetadata: { name, version },
      nsis: { ...original.build.nsis, guid: id, runAfterFinish: false, shortcutName: name, createDesktopShortcut: false, createStartMenuShortcut: false },
      publish: [{ provider: "generic", url: `${url}/updates/`, useMultipleRangeRequest: false }],
    };
    const configFile = join(temp, `config-${version}.json`);
    if (!reuse) {
      writeFileSync(configFile, JSON.stringify(config));
      console.log(`Building update fixture ${version}`);
      await run(process.execPath, [require.resolve("electron-builder/cli.js"), "--config", configFile, "--win", "nsis", "--x64", "--publish", "never"]);
    }
    const installer = `Beam-${version}-win-x64-setup.exe`;
    assets.set(installer, join(out, installer));
    assets.set(`${installer}.blockmap`, join(out, `${installer}.blockmap`));
    if (version === "0.0.2") assets.set("latest.yml", join(out, "latest.yml"));
  }
  console.log("Installing isolated version 0.0.1");
  await run(assets.get("Beam-0.0.1-win-x64-setup.exe"), ["/S", `/D=${installDir}`]);
  await waitUntil(() => installedVersion() === "0.0.1", "baseline installation");
  // A retained fixture can be rerun against this run's newly allocated local server port.
  writeFileSync(join(installDir, "resources/app-update.yml"), JSON.stringify({ provider: "generic", url: `${url}/updates/`, updaterCacheDirName: `${name}-updater`, useMultipleRangeRequest: false }));
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(temp, "profile")}`], env });
  const baselineProcess = desktop.process();
  let installerStarted = false;
  let output = "";
  desktop.process().stdout.on("data", data => {
    process.stdout.write(data);
    output = (output + data).slice(-8000);
    if (output.includes("Update installer has already been triggered")) installerStarted = true;
  });
  desktop.process().stderr.on("data", data => process.stderr.write(data));
  const page = await desktop.firstWindow();
  await waitUntil(async () => (await page.evaluate(() => window.beam.runnerStatus())).pendingPair === "UPDATE-TEST", "runner pairing");
  assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), "0.0.1");
  await page.evaluate(() => window.beam.updateCheck());
  await waitUntil(async () => (await page.evaluate(() => window.beam.updateStatus())).state === "available", "update available");
  assert.equal((await page.evaluate(() => window.beam.updateStatus())).version, "0.0.2");
  await page.evaluate(() => window.beam.updateDownload());
  await waitUntil(async () => (await page.evaluate(() => window.beam.updateStatus())).state === "ready", "download complete", 120000);
  console.log("Update detected and downloaded; installing through Beam's update handler");
  await page.evaluate(() => window.beam.updateInstall());
  console.log("Install status:", await page.evaluate(() => window.beam.updateStatus()).catch(() => "app closed"));
  await waitUntil(() => installerStarted, "installer launch");
  // Node's inspector can hold process exit while Playwright remains attached.
  // Detach only after the actual install handler has launched NSIS and quit the app.
  await desktop.close();
  await waitUntil(async () => {
    if (baselineProcess.exitCode !== null || baselineProcess.signalCode !== null) return true;
    const status = await page.evaluate(() => window.beam.updateStatus()).catch(() => null);
    if (status?.state === "error") throw new Error(`Update install failed: ${status.message}`);
    return false;
  }, "old app exit");
  await waitUntil(() => installedVersion() === "0.0.2", "NSIS replacement", 120000);
  // Confirm --force-run reopened the upgraded application without test intervention.
  await waitUntil(() => {
    const quoted = executable.replace(/'/g, "''");
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' }).Count`], { windowsHide: true, encoding: "utf8" }).trim() !== "0";
  }, "automatic relaunch");
  // Stop only this isolated app before attaching the version verifier.
  stopTestWindows();
  desktop = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(temp, "profile")}`], env });
  assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), "0.0.2");
  const updated = await desktop.firstWindow();
  await waitUntil(async () => (await updated.evaluate(() => window.beam.runnerStatus())).pendingPair === "UPDATE-TEST", "upgraded runner pairing");
  await desktop.close(); desktop = null;
  passed = true;
  console.log("PASS: installed 0.0.1 → checked feed → downloaded 0.0.2 → graceful quit → NSIS upgrade → launched 0.0.2");
} finally {
  // On failure, don't trigger auto-install-on-quit while uninstalling the fixture.
  if (!passed) stopTestWindows();
  await desktop?.close().catch(() => {});
  stopTestWindows();
  const uninstaller = join(installDir, "Uninstall Beam Update Smoke.exe");
  if (existsSync(uninstaller)) await run(uninstaller, ["/S"]).catch(error => console.error("Test uninstall:", error.message));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(`Test build evidence retained at ${temp}`);
}
