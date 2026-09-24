#!/usr/bin/env node
import { ConvexClient } from "convex/browser";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { z } from "zod";
import { adapters, which, profileEnv, hydratePathFromLoginShell } from "@beam/harness";
import { api } from "../../../convex/_generated/api.js";
import { readConfig } from "./config.ts";
import { probeProfiles, manageProfiles, profileFor } from "./profiles.ts";
import { login } from "./login.ts";
import { contributeResource, watchResources } from "./resources.ts";
import { watchRuns } from "./runs.ts";
import { probeOpenFoam, runOpenFoam } from "./compute/openfoam.ts";
import { watchCompute } from "./compute/watch.ts";

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
  return probeProfiles();
}
const line = (s: { harness: string; installed: boolean; version: string | null; auth: string; plan: string | null; email: string | null; message: string | null }) =>
  `${s.harness.padEnd(7)} ${(s.installed ? `v${s.version ?? "?"}` : "missing").padEnd(10)} ${s.auth.padEnd(15)} ${[s.plan, s.email].filter(Boolean).join(" · ")}${s.message ? `  (${s.message})` : ""}`;

if (cmd === "openfoam-job") {
  try { await runOpenFoam(JSON.parse(argv[1] ?? "null"), argv[2] ?? ""); process.exit(0); }
  catch (error) { console.error((error as Error).message); process.exit(1); }
}

if (cmd === "local-servers") { const { discoverLocalServers } = await import("./localServers.ts"); console.log(JSON.stringify(await discoverLocalServers())); process.exit(0); }

if (cmd === "resource-preview") {
  const input = z.object({ chatId: z.string(), resourceId: z.string() }).parse(JSON.parse(argv[1] ?? "null"));
  const cfg = await readConfig(); if (!cfg) throw new Error("Sign in to Beam first");
  const { startResourcePreview } = await import("./resourcePreview.ts");
  const { url } = await startResourcePreview(new ConvexClient(cfg.convexUrl), cfg.token, input.chatId as never, input.resourceId as never);
  console.log(`BEAM_PREVIEW ${url}`);
}

if (cmd === "share-resource") {
  const input = z.object({ chatId: z.string(), name: z.string().min(1).max(120), resource: z.unknown() }).parse(JSON.parse(argv[1] ?? "null"));
  const cfg = await readConfig(); if (!cfg) throw new Error("Sign in to Beam first");
  const client = new ConvexClient(cfg.convexUrl);
  try { console.log(JSON.stringify({ id: await contributeResource(client, cfg.token, input.chatId as never, input.name, input.resource) })); } finally { await client.close(); }
  process.exit(0);
}

if (cmd === "connection-login") {
  const { harness, id } = z.object({ harness: z.enum(["codex", "claude"]), id: z.string() }).parse(JSON.parse(argv[1] ?? "null"));
  await hydratePathFromLoginShell();
  const bin = await which(harness); if (!bin) throw new Error(`Install ${harness} first`);
  const profile = await profileFor(harness, id);
  const child = spawn(bin, harness === "codex" ? ["login"] : ["auth", "login"], { env: profileEnv(harness, profile), stdio: "inherit" });
  child.on("exit", code => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}

if (cmd === "connections") { console.log(JSON.stringify(await manageProfiles(JSON.parse(argv[1] ?? '{"action":"list"}')))); process.exit(0); }

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
  let computeSupported = process.platform !== "win32";
  const registration = { token, name: cfg.name, hostname: hostname(), platform: process.platform, harnesses: statuses, launchedByApp: flag("--app") };
  // Older deployments do not accept the optional compute capability yet.
  const runnerId = await client.mutation(api.runners.hello, { ...registration, openfoam: await probeOpenFoam(), ...(process.platform !== "win32" ? { computeBackend: "local-process" as const } : {}) }).catch(async (error) => {
    if (process.platform === "win32") throw error;
    const id = await client.mutation(api.runners.hello, registration);
    computeSupported = false;
    console.log("Connected in compatibility mode (compute capability not advertised)");
    return id;
  });
  console.log(`BEAM_RUNNER ${runnerId}`);
  console.log(`beam-runner up as ${cfg.githubLogin} · ${statuses.filter((s) => s.installed).map((s) => `${s.harness}${s.auth === "authenticated" ? " ✓" : ""}`).join(", ") || "no harnesses found"}`);
  for (const s of statuses) console.log("  " + line(s));

  let lastProbeReq = 0, probing = false;
  const reprobe = async (why: string) => {
    if (probing) return; probing = true;
    try { statuses = await probeAll(); await client.mutation(api.runners.heartbeat, { token, runnerId, harnesses: statuses, ...(computeSupported ? { openfoam: await probeOpenFoam() } : {}) }); console.log(`re-probed (${why})`); }
    catch (e) { console.error("probe failed", (e as Error).message); }
    finally { probing = false; }
  };
  setInterval(() => client.mutation(api.runners.heartbeat, { token, runnerId }).catch((e) => console.error("heartbeat", (e as Error).message)), 30_000);
  setInterval(() => void reprobe("interval"), 5 * 60_000);
  client.onUpdate(api.runners.self, { token }, (row) => { if (row && row.probeRequestedAt > lastProbeReq) { lastProbeReq = row.probeRequestedAt; void reprobe("requested"); } });
  watchRuns(client, token);
  watchResources(client, token);
  if (computeSupported) watchCompute(client, token);

  const bye = async () => { try { await client.mutation(api.runners.bye, { token, runnerId }); } catch {} process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
