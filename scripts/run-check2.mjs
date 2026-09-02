// Repo-less chat: claude attaches the repo itself via Beam tools, then the next mention lands a branch.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const scratch = process.env.SCRATCH ?? "/tmp/beam-runcheck";
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home"), gitbase = join(scratch, "gitbase"), shots = join(scratch, "shots"), log = join(scratch, "runner.log");
mkdirSync(join(gitbase, "acme"), { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(shots, { recursive: true });
writeFileSync(log, "");

// --- a tiny repo with a main branch ---
const bare = join(gitbase, "acme", "demo.git");
const seed = join(scratch, "seed");
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
git(["init", "--bare", "-b", "main", bare]);
git(["init", "-b", "main", seed]);
mkdirSync(join(seed, "src"));
writeFileSync(join(seed, "README.md"), "# demo\n\nA tiny package used by Beam's run check.\n");
writeFileSync(join(seed, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
git(["add", "-A"], seed); git(["-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-m", "init"], seed);
git(["remote", "add", "origin", bare], seed); git(["push", "origin", "main"], seed);

// --- runner in its own home, pointed at the local git base ---
const env = { ...process.env, BEAM_HOME: home, BEAM_GIT_BASE: `file://${gitbase}/`, FORCE_COLOR: "0" };
const runner = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "apps/runner/src/cli.ts", "start", "--name", "runcheck"], { cwd: root, env });
let out = "";
const onData = (d) => { out += d; appendFileSync(log, d); };
runner.stdout.on("data", onData); runner.stderr.on("data", onData);
const waitOut = (re, ms) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { const m = out.match(re); if (m) { clearInterval(t); res(m); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`runner output never matched ${re}\n${out.slice(-800)}`)); } }, 200); });

const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1380, height: 900 }, colorScheme: "dark" });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const result = { ok: false };
try {
  const [, code] = await waitOut(/^\s+([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m, 30000);
  await p.goto("http://localhost:5173/?pair=" + code, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue as a guest" }).click();
  await p.getByText("+ New chat").waitFor({ timeout: 20000 });
  await p.keyboard.press("Meta+,");
  const inp = p.locator('input[placeholder="XXXX-XXXX"]');
  await inp.fill(code);
  await p.getByText(/is waiting/).waitFor({ timeout: 10000 });
  await p.getByRole("button", { name: "Approve" }).click();
  await waitOut(/beam-runner up as/, 60000);
  await p.locator(".hrow .st.authenticated").first().waitFor({ timeout: 60000 });
  await p.keyboard.press("Escape");

  await p.getByText("+ New chat").click(); await p.getByText("Team chat").first().click();
  await p.getByPlaceholder(/Message Untitled/).waitFor({ timeout: 20000 });
  // the picker: a guest has no GitHub token, so it explains and still takes owner/name
  await p.locator(".repopick").click();
  await p.getByText("+ connect another repo").click();
  await p.locator(".rl-note", { hasText: /Sign out|No repos|GitHub did not/ }).waitFor({ timeout: 15000 });
  const note = await p.locator(".rl-note").innerText();
  await p.locator(".modal .btn.ghost", { hasText: "Cancel" }).click();

  // 1. no repo attached: talk to claude, and let it attach the repo itself
  await p.getByPlaceholder(/Message/).fill("@claude we have no repo attached here. attach acme/demo to this chat, then tell me what you did in one line.");
  await p.keyboard.press("Enter");
  await p.locator(".msg.dispatch").waitFor({ timeout: 10000 });
  await p.locator(".thead .chip", { hasText: "acme/demo" }).waitFor({ timeout: 180_000 });
  await waitOut(/landed|failed/, 180_000).catch(() => {});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: join(shots, "1-attached.png") });
  const firstReport = await p.locator(".msg.report .tx").first().innerText();
  const firstSteps = await p.locator(".step").allInnerTexts();

  // 2. second mention: now it gets a worktree and lands a branch
  await p.getByPlaceholder(/Message/).fill("@claude add a `subtract` function next to `add` in src/math.ts and export it. Keep it tiny, no tests.");
  await p.keyboard.press("Enter");
  const t0 = Date.now(); let approvals = 0;
  while (Date.now() - t0 < 300_000) {
    const ask = p.locator(".ask .perm button", { hasText: /^allow$/ });
    if (await ask.count()) { await ask.first().click(); approvals += 1; }
    if (await p.locator(".card .ttl", { hasText: /^beam\// }).count()) break;
    if (await p.locator(".ask.fail").count()) break;
    await p.waitForTimeout(700);
  }
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(shots, "2-landed.png") });
  const branch = await p.locator(".card .ttl").first().innerText().catch(() => "");
  const math = branch ? git(["show", `${branch}:src/math.ts`], bare) : "";
  result.ok = /subtract/.test(math) && /acme\/demo/.test(firstReport + firstSteps.join(" "));
  Object.assign(result, { note, firstReport: firstReport.slice(0, 300), firstSteps, branch, approvals, math, errs, runnerTail: out.slice(-600) });
} catch (e) {
  await p.screenshot({ path: join(shots, "err.png") }).catch(() => {});
  Object.assign(result, { error: String(e).slice(0, 600), errs, runnerTail: out.slice(-1500) });
} finally {
  runner.kill("SIGINT");
  await b.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
