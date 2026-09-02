#!/usr/bin/env node
import { adapters, hydratePathFromLoginShell } from "@beam/harness";

/**
 * beam-runner: a Convex client that hosts runs on this machine.
 *   beam-runner login   device-code sign-in, registers this machine to a workspace
 *   beam-runner start   hydrate PATH, probe harnesses, heartbeat, claim queued runs
 *   beam-runner probe   print harness status and exit
 * Launched by the desktop app at startup, or by hand on any box. Nothing here assumes an app is attached.
 */
const cmd = process.argv[2] ?? "start";

async function probeAll() {
  await hydratePathFromLoginShell();
  const results = await Promise.all(Object.values(adapters).map((a) => a.probe()));
  return results;
}

if (cmd === "probe") {
  const r = await probeAll();
  for (const s of r) console.log(`${s.harness.padEnd(7)} ${s.installed ? "installed" : "missing  "} ${s.auth.padEnd(15)} ${s.plan ?? ""} ${s.email ?? ""} ${s.message ?? ""}`.trim());
  process.exit(0);
}

if (cmd === "login") {
  console.log("TODO(M1): device-code login against Convex; writes ~/.beam/runner.json with runner id + token");
  process.exit(0);
}

if (cmd === "start") {
  const statuses = await probeAll();
  console.log(`beam-runner up · ${statuses.filter((s) => s.installed).map((s) => s.harness).join(", ") || "no harnesses found"}`);
  console.log("TODO(M1): connect to Convex, register/heartbeat, subscribe to runs.queuedFor");
  // keep alive; the desktop app owns our lifetime
  setInterval(() => {}, 1 << 30);
}
