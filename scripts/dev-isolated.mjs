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
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
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
if (flag("--runner")) childEnv.BEAM_HOME ??= runnerHome;
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
function stop() { for (const c of children) kill(c); process.exit(0); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);

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
  c.on("exit", () => { if (!ready) { children.splice(children.indexOf(c), 1); resolve(null); } else stop(); });
});

let web = null;
for (let tries = 0, port = portArg ?? (await nextFree(5174)); !web; tries++) {
  web = await serveWeb(port);
  if (web) break;
  if (portArg !== null || tries >= 5) { console.error(`the dev server could not start on ${port}`); stop(); }
  port = await nextFree(port + 1);
}

console.log(`web on http://localhost:${web.port}${flag("--web-only") ? "" : flag("--runner") ? ` · runner profile ${childEnv.BEAM_HOME}` : " · no runner (runs go to your usual one)"}`);
if (!flag("--web-only")) start("dev:desktop", web.port).on("exit", stop);
