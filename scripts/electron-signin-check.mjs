// Drives the real Electron app: desktop sign-in via device code, then a reload to check the session persists.
import { _electron as electron, chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const userData = mkdtempSync(join(tmpdir(), "beam-electron-"));
const app = await electron.launch({ args: ["apps/desktop/dist/main.cjs", `--user-data-dir=${userData}`], env: { ...process.env, BEAM_DEV: "1", BEAM_TEST: "1", ELECTRON_ENABLE_LOGGING: "1" } });
const logs = [];
app.process().stdout.on("data", (d) => logs.push(String(d)));
app.process().stderr.on("data", (d) => logs.push("! " + String(d)));
const win = await app.firstWindow();
win.on("console", (m) => logs.push(`[console ${m.type()}] ${m.text()}`));
win.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const browser = await (await b.newContext({ viewport: { width: 1380, height: 860 } })).newPage();
try {
  await win.getByRole("button", { name: "Continue with GitHub in your browser" }).waitFor({ timeout: 30000 });
  await win.getByRole("button", { name: "Continue with GitHub in your browser" }).click();
  await win.getByText("Finish signing in in your browser").waitFor({ timeout: 15000 });
  let url = null;
  for (let i = 0; i < 40 && !url; i++) { await new Promise((r) => setTimeout(r, 250)); const m = logs.join("").match(/BEAM_OPEN (\S+)/); if (m) url = m[1]; }
  const wsProbe = await win.evaluate((u) => new Promise((res) => { const ws = new WebSocket(u.replace("https://", "wss://") + "/api/1.29.0/sync"); const t = setTimeout(() => res("ws timeout"), 8000); ws.onopen = () => { clearTimeout(t); ws.close(); res("ws open"); }; ws.onerror = (e) => { clearTimeout(t); res("ws error"); }; }), "https://cautious-fish-858.convex.cloud");
  const fetchProbe = await win.evaluate(async () => { try { const r = await fetch("https://cautious-fish-858.convex.site/runner/device/poll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return "fetch " + r.status; } catch (e) { return "fetch error " + e; } });
  logs.push(`[probe] ${wsProbe} · ${fetchProbe}\n`);
  await browser.goto(url, { waitUntil: "networkidle" });
  await browser.getByRole("button", { name: "Continue as a guest" }).click();
  await browser.getByRole("button", { name: "Approve" }).waitFor({ timeout: 20000 });
  await browser.getByRole("button", { name: "Approve" }).click();
  await browser.getByText("Approved. You can go back to Beam.").waitFor({ timeout: 10000 });
  const first = await Promise.race([
    win.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 30000 }).then(() => "signed-in"),
    new Promise((r) => setTimeout(() => r("timeout"), 31000)),
  ]);
  const keys1 = await win.evaluate(() => Object.keys(localStorage));
  await win.reload();
  const after = await Promise.race([
    win.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 15000 }).then(() => "signed-in"),
    win.getByRole("button", { name: "Continue with GitHub in your browser" }).waitFor({ timeout: 15000 }).then(() => "signed-out"),
  ]);
  const keys2 = await win.evaluate(() => Object.keys(localStorage));
  console.log(JSON.stringify({ first, after, keys1, keys2, url }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300) })); }
finally { console.log("--- logs:\n" + logs.filter((l) => /probe|device sign-in|pageerror|error/i.test(l) && !/Security Warning/.test(l)).slice(-30).join("")); await b.close(); await app.close(); }
