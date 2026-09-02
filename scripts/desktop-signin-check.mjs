// Desktop sign-in: an "Electron" page (window.beam stubbed) starts a device code and opens the system browser;
// a separate browser context signs in as a guest and approves; the desktop page ends up signed in as that user.
import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const desktopCtx = await b.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: "dark" });
await desktopCtx.addInitScript(() => {
  window.__opened = [];
  window.beam = { platform: "darwin", openExternal: async (u) => { window.__opened.push(u); }, openTerminalWith: async () => {}, pickFolder: async () => null,
    runnerStatus: async () => ({ running: false, pid: null, pendingPair: null, log: [] }), restartRunner: async () => {}, onPairCode: () => () => {}, onRunnerLog: () => () => {} };
});
const desktop = await desktopCtx.newPage();
const browser = await (await b.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: "dark" })).newPage();
const errs = []; for (const p of [desktop, browser]) p.on("pageerror", (e) => errs.push(e.message));
try {
  await desktop.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await desktop.getByRole("button", { name: "Continue with GitHub in your browser" }).click();
  await desktop.getByText("Finish signing in in your browser").waitFor({ timeout: 15000 });
  const url = await desktop.evaluate(() => window.__opened[0]);
  const code = await desktop.locator(".mono").filter({ hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).innerText();
  await desktop.screenshot({ path: "/tmp/beam-shots/desktop-waiting.png" });
  // the "system browser": sign in as a guest, land on the approval screen
  await browser.goto(url, { waitUntil: "networkidle" });
  await browser.getByRole("button", { name: "Continue as a guest" }).click();
  await browser.getByRole("heading", { name: /Sign in Beam on your Mac/ }).waitFor({ timeout: 20000 });
  await browser.getByText("is waiting with code").waitFor({ timeout: 10000 });
  await browser.screenshot({ path: "/tmp/beam-shots/browser-approve.png" });
  const guest = (await browser.locator(".box b").innerText()).trim();
  await browser.getByRole("button", { name: "Approve" }).click();
  await browser.getByText("Approved. You can go back to Beam.").waitFor({ timeout: 10000 });
  // desktop should now be signed in as that guest
  await desktop.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 30000 });
  await desktop.screenshot({ path: "/tmp/beam-shots/desktop-signed-in.png" });
  console.log(JSON.stringify({ ok: true, url, code, guest, errs }));
} catch (e) { await desktop.screenshot({ path: "/tmp/beam-shots/ds-err-desktop.png" }); await browser.screenshot({ path: "/tmp/beam-shots/ds-err-browser.png" }); console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300), errs })); }
finally { await b.close(); }
