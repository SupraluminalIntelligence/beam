#!/usr/bin/env node
// Point this checkout at your personal Convex dev deployment and make it usable, without touching production.
//
//   node scripts/dev-backend.mjs          select your dev deployment, push convex/, set auth keys and SITE_URL,
//                                         write apps/web/.env.local
//   node scripts/dev-backend.mjs --check  report what is configured, change nothing
//
// Idempotent: existing environment variables are kept, never overwritten. Secret values are never printed.
// GitHub sign-in needs its own OAuth app for the dev deployment; the script prints how to add one.
// Anonymous sign-in works without it. See docs/dev-backend.md.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const SITE_URL = "http://localhost:5173";

function convex(args, { quiet = false } = {}) {
  const r = spawnSync(process.execPath, [join(root, "node_modules/convex/bin/main.js"), ...args], { cwd: root, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) {
    if (quiet) process.stderr.write(r.stderr ?? "");
    throw new Error(`npx convex ${args[0]} ${args[1] ?? ""} failed`);
  }
  return r.stdout ?? "";
}
function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// 1. Select the personal dev deployment. `deployment select dev` rewrites .env.local; it needs a project to start from.
const rootEnvFile = join(root, ".env.local");
let env = readEnv(rootEnvFile);
if (!env.CONVEX_DEPLOYMENT) fail(".env.local has no CONVEX_DEPLOYMENT. Copy the CONVEX_DEPLOYMENT line from your main checkout's .env.local, or run `npx convex dev --configure existing` once.");
if (!env.CONVEX_DEPLOYMENT.startsWith("dev:")) {
  if (check) fail(`this checkout points at ${env.CONVEX_DEPLOYMENT}, not a dev deployment`);
  convex(["deployment", "select", "dev"]);
  env = readEnv(rootEnvFile);
}
if (!env.CONVEX_DEPLOYMENT?.startsWith("dev:")) fail(`refusing to continue: ${env.CONVEX_DEPLOYMENT} is not a dev deployment`);
const url = env.CONVEX_URL, site = env.CONVEX_SITE_URL;
console.log(`✓ dev deployment ${env.CONVEX_DEPLOYMENT.slice(4)} · ${url}`);

// 2. Push this checkout's convex/ (also writes convex/_generated).
if (!check) { convex(["dev", "--once", "--typecheck", "disable"]); console.log("✓ pushed convex/ to the dev deployment"); }

// 3. Environment variables, by name only.
const names = new Set(convex(["env", "list"], { quiet: true }).split("\n").map((l) => l.split("=")[0].trim()).filter((n) => /^[A-Z0-9_]+$/.test(n)));
const set = (name, value) => { convex(["env", "set", "--", name, value], { quiet: true }); names.add(name); console.log(`✓ set ${name}`); };
if (!names.has("JWT_PRIVATE_KEY") || !names.has("JWKS")) {
  if (check) console.log("✗ JWT_PRIVATE_KEY / JWKS missing");
  else {
    // Same format as `npx @convex-dev/auth`: PKCS8 PEM with newlines as spaces, and a JWKS holding the public key.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    set("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).trimEnd().replace(/\n/g, " "));
    set("JWKS", JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] }));
  }
} else console.log("✓ JWT_PRIVATE_KEY and JWKS already set");
if (!names.has("SITE_URL")) check ? console.log("✗ SITE_URL missing") : set("SITE_URL", SITE_URL);
else console.log("✓ SITE_URL already set");
const github = names.has("AUTH_GITHUB_ID") && names.has("AUTH_GITHUB_SECRET");
console.log(github ? "✓ GitHub sign-in configured" : "· GitHub sign-in not configured: use Guest sign-in, or add a dev OAuth app (docs/dev-backend.md)");

// 4. The web app's backend. dev:isolated would otherwise copy the main checkout's file, which points at production.
const webEnvFile = join(root, "apps/web/.env.local");
const web = readEnv(webEnvFile);
if (web.VITE_CONVEX_URL === url) console.log("✓ apps/web/.env.local points at the dev deployment");
else if (check) console.log(`✗ apps/web/.env.local points at ${web.VITE_CONVEX_URL ?? "nothing"}`);
else {
  writeFileSync(webEnvFile, `# Written by scripts/dev-backend.mjs: this checkout's personal Convex dev deployment.\nVITE_CONVEX_URL=${url}\nVITE_SITE_URL=${SITE_URL}\n`);
  console.log(`✓ wrote apps/web/.env.local${web.VITE_CONVEX_URL ? ` (was ${web.VITE_CONVEX_URL})` : ""}`);
}

console.log(`
Run against it:
  BEAM_CONVEX_URL=${url} pnpm dev:isolated --runner    UI + a runner paired to the dev backend
  pnpm convex                                              watch convex/ and push changes to the dev deployment
Never use --takeover with a dev backend: it runs on the runner profile paired with production.
${github ? "" : `GitHub OAuth callback for a dev OAuth app: ${site}/api/auth/callback/github\n`}`);
