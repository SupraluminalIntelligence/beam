#!/usr/bin/env node
// Run this checkout's web UI and desktop window beside other checkouts, e.g. several
// git worktrees each testing a different branch. See CONTRIBUTING.md, "Several checkouts at once".
//
//   pnpm dev:isolated              first free port from 5174, no runner of its own (borrows Beam's)
//   pnpm dev:isolated --port 5180  a fixed port
//   pnpm dev:isolated --runner     also start a runner, under its own BEAM_HOME (pair it once)
//   pnpm dev:isolated --takeover   quit Beam (when idle) and run this checkout's runner on the usual profile; reopen Beam after
//   pnpm dev:isolated --web-only   just the dev server, for a browser
//
// Everything still talks to the one Convex deployment in apps/web/.env.local. Backend changes
// in this checkout are not live until someone deploys them.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : null;

// A new worktree has no gitignored env file. Borrow the main checkout's, which only names the Convex deployment.
const env = join(root, "apps/web/.env.local");
if (!existsSync(env)) {
  const main = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n")[0]?.replace(/^worktree /, "");
  const source = main && join(main, "apps/web/.env.local");
  if (!source || source === env || !existsSync(source)) { console.error("apps/web/.env.local is missing. Create it from apps/web/.env.example (CONTRIBUTING.md)."); process.exit(1); }
  copyFileSync(source, env);
  console.log(`copied apps/web/.env.local from ${main}`);
}

const free = (port) => new Promise((ok) => { const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true))).listen(port, "::"); });
const nextFree = async (from) => { for (let p = from; p <= 5199; p++) if (await free(p)) return p; console.error(`no free port in ${from}-5199`); process.exit(1); };
if (portArg !== null && !(await free(portArg))) { console.error(`port ${portArg} is taken`); process.exit(1); }

// Two worktrees can share a folder name (…/a/beam, …/b/beam); the path hash keeps their runner profiles apart.
const runnerHome = join(homedir(), `.beam-dev-${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`);
const childEnv = { ...process.env };

// --takeover: this checkout's runner stands in for Beam's on the usual profile, so the window is this Mac exactly as Beam
// would be, running this branch's runner. Two runners on one profile race for runs, so Beam quits first and reopens after.
const BEAM_APP = "ai.supraluminal.beam";
const sharedHome = join(homedir(), ".beam");
const osascript = (script) => spawnSync("osascript", ["-e", script], { encoding: "utf8" }).stdout?.trim();
const beamOpen = () => osascript(`application id "${BEAM_APP}" is running`) === "true";
/** Runners on the usual profile: Beam's (runner.mjs) and any checkout's (src/cli.ts) without a BEAM_HOME of its own. */
function sharedRunners() {
  const ps = spawnSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  return ps.split("\n").filter((l) => /(runner\.mjs|src\/cli\.ts) start\b/.test(l))
    .filter((l) => { const home = l.match(/ BEAM_HOME=(\S+)/)?.[1]; return !home || home === sharedHome; })
    .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), packaged: /runner\.mjs start\b/.test(l) }));
}
/**
 * What Beam's runner is running right now: the agent CLIs of runs in progress and any compute job, all its children.
 * Quitting Beam would interrupt them (the runner lands what they did before it exits), so takeover waits for none.
 */
function runnerWork() {
  const runners = new Set(sharedRunners().filter((r) => r.packaged).map((r) => r.pid));
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout ?? "";
  return [...new Set(ps.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter((m) => m && runners.has(Number(m[2]))).map((m) => basename(m[3])))];
}
/**
 * One takeover at a time. Two checkouts that both checked before either quit Beam would otherwise both start a runner on
 * the profile. Creating the lock file is atomic; a lock left by a process that is gone is taken over.
 */
const lockFile = join(sharedHome, "dev-takeover.lock");
let lockHeld = false;
function takeLock() {
  mkdirSync(sharedHome, { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try { writeFileSync(lockFile, String(process.pid), { flag: "wx" }); lockHeld = true; return null; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    const holder = Number(readFileSync(lockFile, "utf8"));
    try { process.kill(holder, 0); return holder; } catch { try { unlinkSync(lockFile); } catch {} }
  }
  return -1;
}
process.on("exit", () => { if (lockHeld) try { unlinkSync(lockFile); } catch {} });
const waitFor = async (ok, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (ok()) return true; return ok(); };
const ask = (question) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => process.exit(130));
  rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
});
const fail = (message) => { console.error(message); process.exit(1); };
let reopenBeam = false;
if (flag("--takeover")) {
  if (process.platform !== "darwin") fail("--takeover is macOS only for now");
  if (flag("--runner") || flag("--web-only")) fail("--takeover starts the desktop window with its own runner; drop --runner and --web-only");
  const holder = takeLock();
  if (holder) fail(`another checkout is taking over ${sharedHome}${holder > 0 ? ` (pid ${holder})` : ""}. Stop it first.`);
  const others = sharedRunners().filter((r) => !r.packaged);
  if (others.length) fail(`another checkout's runner is using ${sharedHome} (pid ${others.map((r) => r.pid).join(", ")}). Stop it first.`);
  const busy = () => { const work = runnerWork(); if (work.length) fail(`Beam is running something right now (${work.join(", ")}). Quitting it would stop that before it lands. Let it finish or stop it in Beam, then try again.`); };
  if (beamOpen()) {
    busy();
    if (!process.stdin.isTTY) fail("Beam is open. --takeover asks before quitting it, so run it in a terminal.");
    if (!(await ask("Beam is open. Quit it so this window can run this checkout's runner? [y/N] "))) process.exit(1);
    busy(); // a run may have started while the question was open
    osascript(`quit app id "${BEAM_APP}"`);
    // A run that started after the check above is landed before Beam's runner exits (RUNNER_GRACE_MS in apps/desktop).
    if (!(await waitFor(() => !beamOpen() && sharedRunners().length === 0, 65_000))) fail("Beam did not quit");
    reopenBeam = true;
  } else if (sharedRunners().length) fail(`a runner is using ${sharedHome} (pid ${sharedRunners().map((r) => r.pid).join(", ")}). Stop it first.`);
}

if (flag("--takeover")) { delete childEnv.BEAM_HOME; delete childEnv.BEAM_NO_RUNNER; }
else if (flag("--runner")) { childEnv.BEAM_HOME = runnerHome; delete childEnv.BEAM_NO_RUNNER; } // never inherited: two worktrees would share a runner, or get none
else childEnv.BEAM_NO_RUNNER = "1";

// A local VITE_SITE_URL (the contributor setup) is where the app sends the browser for GitHub access; follow the port.
// A hosted one (the maintainer setup leaves it unset) works from any port and stays as it is.
const siteUrl = process.env.VITE_SITE_URL ?? readFileSync(env, "utf8").match(/^VITE_SITE_URL=(.*)$/m)?.[1]?.trim();
const localSite = !!siteUrl && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(siteUrl);

const windows = process.platform === "win32";
const children = [];
const start = (script, port, opts = {}) => {
  const c = spawn("pnpm", [script], { cwd: root, env: { ...childEnv, BEAM_WEB_PORT: String(port), ...(localSite ? { VITE_SITE_URL: `http://localhost:${port}` } : {}) }, stdio: opts.stdio ?? "inherit", detached: !windows, shell: windows });
  children.push(c);
  return c;
};
// Signal each child's whole tree: pnpm's children (Vite, Electron) outlive pnpm otherwise.
const kill = (c) => { try { if (windows) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-c.pid, "SIGTERM"); } catch {} };
// After a takeover, Beam comes back once this checkout's runner has let go of the profile.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) kill(c);
  // The runner lands any run in progress before it exits, which can take up to a minute (RUNNER_GRACE_MS in apps/desktop).
  if (reopenBeam) { await waitFor(() => sharedRunners().length === 0, 65_000); spawnSync("open", ["-b", BEAM_APP]); console.log("reopened Beam"); }
  process.exit(0);
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());

/**
 * Start Vite and wait for it to say it serves `port`. Probing for a free port and then binding it is a race with
 * another checkout doing the same; strictPort makes the loser exit, so the loser tries the next port. Only this Vite's
 * own "Local: …:port" line counts, never a connection that some other checkout's server could answer.
 */
const serveWeb = (port) => new Promise((resolve) => {
  const c = start("dev:web", port, { stdio: ["ignore", "pipe", "inherit"] });
  let ready = false;
  createInterface({ input: c.stdout }).on("line", (line) => {
    process.stdout.write(line + "\n");
    if (!ready && line.replace(/\x1b\[[0-9;]*m/g, "").includes(`localhost:${port}/`)) { ready = true; resolve({ child: c, port }); }
  });
  c.on("exit", () => { if (!ready) { children.splice(children.indexOf(c), 1); resolve(null); } else void stop(); });
});

let web = null;
for (let tries = 0, port = portArg ?? (await nextFree(5174)); !web; tries++) {
  web = await serveWeb(port);
  if (web) break;
  if (portArg !== null || tries >= 5) { console.error(`the dev server could not start on ${port}`); await stop(); }
  port = await nextFree(port + 1);
}

console.log(`web on http://localhost:${web.port}${flag("--web-only") ? "" : flag("--takeover") ? ` · this checkout's runner on ${sharedHome}` : flag("--runner") ? ` · runner profile ${childEnv.BEAM_HOME}` : " · no runner (runs go to your usual one)"}`);
if (!flag("--web-only")) start("dev:desktop", web.port).on("exit", () => void stop());
