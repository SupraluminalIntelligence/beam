// How smooth does a streamed reply look? Pairs a fresh runner, asks claude for a few sentences in a
// repo-less chat, and records every change of the message text inside the page.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const scratch = process.env.SCRATCH ?? "/tmp/beam-streamcheck";
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home"); mkdirSync(home, { recursive: true });
const env = { ...process.env, BEAM_HOME: home, FORCE_COLOR: "0" };
const runner = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "apps/runner/src/cli.ts", "start", "--name", "streamcheck"], { cwd: root, env });
let out = ""; runner.stdout.on("data", (d) => (out += d)); runner.stderr.on("data", (d) => (out += d));
const waitOut = (re, ms) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { const m = out.match(re); if (m) { clearInterval(t); res(m); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`no match ${re}\n${out.slice(-600)}`)); } }, 200); });

const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1380, height: 900 }, colorScheme: "dark" });
const result = { ok: false };
try {
  const [, code] = await waitOut(/^\s+([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m, 30000);
  await p.goto("http://localhost:5173/?pair=" + code, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue as a guest" }).click();
  await p.getByText("+ New chat").waitFor({ timeout: 20000 });
  await p.keyboard.press("Meta+,");
  await p.locator('input[placeholder="XXXX-XXXX"]').fill(code);
  await p.getByText(/is waiting/).waitFor({ timeout: 10000 });
  await p.getByRole("button", { name: "Approve" }).click();
  await waitOut(/beam-runner up as/, 60000);
  await p.locator(".hrow .st.authenticated").first().waitFor({ timeout: 60000 });
  await p.keyboard.press("Escape");
  await p.getByText("+ New chat").click(); await p.getByText("Team chat").first().click();
  await p.getByPlaceholder(/Message Untitled/).waitFor({ timeout: 20000 });
  await p.evaluate(() => {
    window.__samples = [];
    let last = -1;
    const obs = new MutationObserver(() => {
      const els = document.querySelectorAll(".msg.report .tx");
      const len = els.length ? els[els.length - 1].textContent.length : 0;
      if (len !== last) { window.__samples.push([performance.now(), len]); last = len; }
    });
    obs.observe(document.querySelector(".msgs"), { childList: true, characterData: true, subtree: true });
  });
  await p.getByPlaceholder(/Message/).fill("@claude in about eight sentences, explain what a git worktree is and why a tool like this one would use one per chat. Prose only, no lists, no code.");
  await p.keyboard.press("Enter");
  await waitOut(/\[run \w+\] (landed|failed)|attached/, 180_000).catch(() => {});
  await p.locator(".act .st.done").first().waitFor({ timeout: 180_000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const samples = await p.evaluate(() => window.__samples);
  const gaps = samples.slice(1).map((s, i) => s[0] - samples[i][0]).filter((g) => g < 1500).sort((a, b) => a - b);
  const q = (f) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))] ?? 0);
  const total = samples.length ? samples[samples.length - 1][1] : 0;
  const dur = samples.length > 1 ? samples[samples.length - 1][0] - samples[0][0] : 0;
  const steps = samples.slice(1).map((s, i) => s[1] - samples[i][1]).filter((d) => d > 0).sort((a, b) => a - b);
  result.ok = total > 200;
  Object.assign(result, { chars: total, seconds: +(dur / 1000).toFixed(1), updates: samples.length, gapMs: { p50: q(0.5), p90: q(0.9), max: q(1) }, charsPerUpdate: { p50: steps[Math.floor(steps.length / 2)], p90: steps[Math.floor(steps.length * 0.9)], max: steps[steps.length - 1] } });
} catch (e) { Object.assign(result, { error: String(e).slice(0, 500), runnerTail: out.slice(-800) }); }
finally { runner.kill("SIGINT"); await b.close(); }
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
