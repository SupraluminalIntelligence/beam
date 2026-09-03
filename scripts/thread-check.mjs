// Threads: two repos in one thread, one dispatch changes both, two landings, then the thread is marked done.
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
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const bares = {};
for (const name of ["web", "api"]) {
  const bare = join(gitbase, "acme", `${name}.git`), seed = join(scratch, `seed-${name}`);
  git(["init", "--bare", "-b", "main", bare]); git(["init", "-b", "main", seed]); mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "README.md"), `# ${name}\n`);
  writeFileSync(join(seed, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(["add", "-A"], seed); git(["-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-m", "init"], seed);
  git(["remote", "add", "origin", bare], seed); git(["push", "origin", "main"], seed);
  bares[name] = bare;
}

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
  await p.getByRole("button", { name: "Approve", exact: true }).click();
  await waitOut(/beam-runner up as/, 60000);
  await p.locator(".hrow .st.authenticated").first().waitFor({ timeout: 60000 });
  await p.keyboard.press("Escape");

  await p.getByText("+ New chat").click(); await p.getByText("Team chat").first().click();
  await p.getByPlaceholder(/Message Untitled/).waitFor({ timeout: 20000 });
  for (const name of ["web", "api"]) {
    await p.locator(".repopick").click();
    await p.getByText("+ connect another repo").click();
    await p.getByPlaceholder(/owner\/name/).fill(`acme/${name}`);
    await p.locator(".modal .btn").filter({ hasText: /^Connect$/ }).click();
    await p.locator(".thead .chip.change", { hasText: name }).waitFor({ timeout: 10000 });
  }
  await p.getByPlaceholder(/Message/).fill("@claude in this thread there are two repo folders, web and api. Add an exported `subtract` to web/src/math.ts and an exported `multiply` to api/src/math.ts. Tiny, no tests.");
  await p.keyboard.press("Enter");
  await p.locator(".msg.dispatch").waitFor({ timeout: 10000 });
  await p.locator(".msg.report").waitFor({ timeout: 20000 });
  await p.screenshot({ path: join(shots, "1-dispatched.png") });

  // approve whatever the agent asks for, until it lands
  const t0 = Date.now(); let approvals = 0;
  // sample what the reader sees: how often the streamed text changes
  const samples = []; let lastLen = -1;
  while (Date.now() - t0 < 300_000) {
    const ask = p.locator(".ask .perm button").first();
    if (await ask.count()) { await ask.first().click(); approvals += 1; await p.screenshot({ path: join(shots, `2-approve-${approvals}.png`) }); }
    if ((await p.locator(".card .ttl", { hasText: /^beam\// }).count()) >= 2) break;
    if (await p.locator(".ask.fail").count()) break;
    const len = await p.evaluate(() => { const els = document.querySelectorAll(".msg.report .tx"); return els.length ? els[els.length - 1].textContent.length : 0; });
    if (len !== lastLen) { samples.push([Date.now() - t0, len]); lastLen = len; }
    await p.waitForTimeout(30);
  }
  const gaps = samples.slice(1).map((s, i) => s[0] - samples[i][0]).filter((g) => g < 2000).sort((a, b) => a - b);
  const stream = { updates: samples.length, medianGapMs: gaps[Math.floor(gaps.length / 2)] ?? null, p90GapMs: gaps[Math.floor(gaps.length * 0.9)] ?? null, charsPerUpdate: samples.length > 1 ? Math.round(samples[samples.length - 1][1] / samples.length) : null };
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(shots, "3-landed.png"), fullPage: false });
  const cards = await p.locator(".card .mt").allInnerTexts();
  const chips = await p.locator(".thead .chip.change").allInnerTexts();
  const web = git(["branch", "--list", "beam/*"], bares.web), api = git(["branch", "--list", "beam/*"], bares.api);
  const webMath = web ? git(["show", `${web.trim().replace(/^\* /, "")}:src/math.ts`], bares.web) : "";
  const apiMath = api ? git(["show", `${api.trim().replace(/^\* /, "")}:src/math.ts`], bares.api) : "";
  // settle the thread
  await p.locator(".donebtn").click();
  await p.locator(".donebtn.settled").waitFor({ timeout: 10000 });
  const doneLabel = await p.locator(".donebtn").innerText();
  await p.screenshot({ path: join(shots, "4-done.png") });
  result.ok = /subtract/.test(webMath) && /multiply/.test(apiMath) && cards.length >= 2;
  Object.assign(result, { cards: cards.map((c) => c.replace(/\s+/g, " ")), chips, webBranch: web, apiBranch: api, webMath, apiMath, doneLabel, errs, stream });
} catch (e) {
  await p.screenshot({ path: join(shots, "err.png") }).catch(() => {});
  Object.assign(result, { error: String(e).slice(0, 600), errs, runnerTail: out.slice(-1500) });
} finally {
  runner.kill("SIGINT");
  await b.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
