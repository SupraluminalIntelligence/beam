// Exercise the packaged app without pairing a real runner or using provider credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

const home = await mkdtemp(join(tmpdir(), "beam-windows-smoke-"));
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/runner/device/start"
    ? { deviceCode: "smoke", userCode: "SMOKE-TEST", verifyUrl: "http://localhost" }
    : { status: "pending" }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const env = { ...process.env, BEAM_HOME: home, BEAM_CONVEX_URL: `http://127.0.0.1:${server.address().port}` };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await _electron.launch({ executablePath: resolve("apps/desktop/release/win-unpacked/Beam.exe"), args: [`--user-data-dir=${join(home, "electron")}`], env });
  const page = await desktop.firstWindow();
  page.on("pageerror", error => console.error("Renderer:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  console.log("Renderer URL:", page.url());
  await page.waitForFunction(() => /beam/i.test(document.body.innerText));
  const pairingDeadline = Date.now() + 30000;
  while ((await page.evaluate(() => window.beam.runnerStatus())).pendingPair !== "SMOKE-TEST") {
    if (Date.now() > pairingDeadline) throw new Error("Runner did not reach pairing");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = await page.evaluate(() => window.beam.runnerStatus());
  assert.equal(status.running, true);
  assert.ok(status.pid);
  await mkdir("apps/desktop/release", { recursive: true });
  await page.screenshot({ path: "apps/desktop/release/windows-smoke.png" });
  const exited = new Promise(resolve => desktop.process().once("exit", resolve));
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Window close did not quit Beam")), 10000); })]);
  } finally { clearTimeout(timer); }
  assert.throws(() => process.kill(status.pid, 0), "Runner must exit along with the window");
  console.log("Windows smoke passed: packaged renderer, preload, runner pairing, window close, runner exit.");
} finally {
  await desktop?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
