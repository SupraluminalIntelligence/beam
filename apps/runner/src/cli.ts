#!/usr/bin/env node
import { ConvexClient } from "convex/browser";
import { hostname } from "node:os";
import { adapters, hydratePathFromLoginShell } from "@beam/harness";
import { api } from "../../../convex/_generated/api.js";
import { readConfig } from "./config.ts";
import { login } from "./login.ts";
import { watchRuns } from "./runs.ts";

/**
 * beam-runner: a standalone Convex client that hosts runs on this machine.
 *   beam-runner login [--name X]   device-code sign-in, writes ~/.beam/runner.json
 *   beam-runner start [--app]      probe harnesses, heartbeat, host runs dispatched to this machine
 *   beam-runner probe              print harness status and exit
 *   beam-runner logout
 * Launched by the desktop app at startup (--app) or by hand on any box. Nothing assumes an app is attached.
 */
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "start";
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

async function probeAll() {
  await hydratePathFromLoginShell();
  return Promise.all(Object.values(adapters).map((a) => a.probe()));
}
const line = (s: { harness: string; installed: boolean; version: string | null; auth: string; plan: string | null; email: string | null; message: string | null }) =>
  `${s.harness.padEnd(7)} ${(s.installed ? `v${s.version ?? "?"}` : "missing").padEnd(10)} ${s.auth.padEnd(15)} ${[s.plan, s.email].filter(Boolean).join(" · ")}${s.message ? `  (${s.message})` : ""}`;

if (cmd === "probe") {
  for (const s of await probeAll()) console.log(line(s));
  process.exit(0);
}
if (cmd === "login") { await login({ ...(opt("--name") ? { name: opt("--name")! } : {}), fromApp: flag("--app") }); process.exit(0); }
if (cmd === "logout") { const { rm } = await import("node:fs/promises"); const { beamHome } = await import("./config.ts"); await rm(`${beamHome()}/runner.json`, { force: true }); console.log("logged out"); process.exit(0); }

if (cmd === "start") {
  let cfg = await readConfig();
  if (!cfg) { await login({ ...(opt("--name") ? { name: opt("--name")! } : {}), fromApp: flag("--app") }); cfg = (await readConfig())!; }
  const client = new ConvexClient(cfg.convexUrl);
  const token = cfg.token;
  let statuses = await probeAll();
  const runnerId = await client.mutation(api.runners.hello, { token, name: cfg.name, hostname: hostname(), platform: process.platform, harnesses: statuses, launchedByApp: flag("--app") });
  console.log(`beam-runner up as ${cfg.githubLogin} · ${statuses.filter((s) => s.installed).map((s) => `${s.harness}${s.auth === "authenticated" ? " ✓" : ""}`).join(", ") || "no harnesses found"}`);
  for (const s of statuses) console.log("  " + line(s));

  let lastProbeReq = 0, probing = false;
  const reprobe = async (why: string) => {
    if (probing) return; probing = true;
    try { statuses = await probeAll(); await client.mutation(api.runners.heartbeat, { token, runnerId, harnesses: statuses }); console.log(`re-probed (${why})`); }
    catch (e) { console.error("probe failed", (e as Error).message); }
    finally { probing = false; }
  };
  setInterval(() => client.mutation(api.runners.heartbeat, { token, runnerId }).catch((e) => console.error("heartbeat", (e as Error).message)), 30_000);
  setInterval(() => void reprobe("interval"), 5 * 60_000);
  client.onUpdate(api.runners.self, { token }, (row) => { if (row && row.probeRequestedAt > lastProbeReq) { lastProbeReq = row.probeRequestedAt; void reprobe("requested"); } });
  watchRuns(client, token);

  const bye = async () => { try { await client.mutation(api.runners.bye, { token, runnerId }); } catch {} process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
