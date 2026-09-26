#!/usr/bin/env node
// Run this checkout's web UI and desktop window beside other checkouts, e.g. several
// git worktrees each testing a different branch. See CONTRIBUTING.md, "Several checkouts at once".
//
//   pnpm dev:isolated              first free port from 5174, no runner of its own
//   pnpm dev:isolated --port 5180  a fixed port
//   pnpm dev:isolated --runner     also start a runner, under its own BEAM_HOME (pair it once)
//   pnpm dev:isolated --web-only   just the dev server, for a browser
//
// Everything still talks to the one Convex deployment in apps/web/.env.local. Backend changes
// in this checkout are not live until someone deploys them.
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
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
const listening = (port) => new Promise((ok) => { const c = connect(port, "localhost").once("connect", () => { c.end(); ok(true); }).once("error", () => ok(false)); });
let port = portArg ?? 5174;
if (portArg !== null && !(await free(port))) { console.error(`port ${port} is taken`); process.exit(1); }
while (!(await free(port))) { if (++port > 5199) { console.error("no free port in 5174-5199"); process.exit(1); } }

const childEnv = { ...process.env, BEAM_WEB_PORT: String(port) };
if (flag("--runner")) childEnv.BEAM_HOME ??= join(homedir(), `.beam-dev-${basename(root)}`);
else childEnv.BEAM_NO_RUNNER = "1";

const children = [];
const start = (script) => { const c = spawn("pnpm", [script], { cwd: root, env: childEnv, stdio: "inherit", detached: true }); children.push(c); c.on("exit", stop); return c; };
function stop() { for (const c of children) try { process.kill(-c.pid, "SIGTERM"); } catch {} process.exit(0); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);

console.log(`web on http://localhost:${port}${flag("--web-only") ? "" : flag("--runner") ? ` · runner profile ${childEnv.BEAM_HOME}` : " · no runner (runs go to your usual one)"}`);
start("dev:web");
if (!flag("--web-only")) {
  for (let i = 0; !(await listening(port)); i++) { if (i > 120) { console.error("the dev server did not come up"); stop(); } await new Promise((r) => setTimeout(r, 500)); }
  start("dev:desktop");
}
