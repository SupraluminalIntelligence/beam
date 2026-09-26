#!/usr/bin/env node
// Refuse a Convex deploy that would remove functions the deployment still serves.
// `convex deploy` replaces the whole function set, so deploying a checkout that
// lacks a function deletes it, and installed phone and desktop builds that call
// it start failing. It inspects the deployment `convex deploy` would target: the
// one CONVEX_DEPLOY_KEY names, or else the project's production deployment.
//
//   pnpm convex:removals             exits 1 if anything would be removed
//   pnpm convex:removals --local     prints this checkout's functions
//
// BEAM_ALLOW_CONVEX_REMOVALS=1 reports removals without failing, for removing
// functions on purpose once no supported client calls them.
// HTTP routes are not compared.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const dir = join(root, "convex");

// convex/ imports its siblings without extensions, as a bundler allows; Node needs them.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (!/^\\.\\.?\\//.test(specifier) || /\\.[cm]?[jt]s$/.test(specifier)) throw error;
    for (const suffix of [".ts", ".js", "/index.ts"]) {
      try { return await next(specifier + suffix, context); } catch {}
    }
    throw error;
  }
}`)}`);

function modules(at) {
  return readdirSync(at, { withFileTypes: true }).flatMap(entry => {
    const path = join(at, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" ? [] : modules(path);
    if (!/\.[jt]s$/.test(entry.name) || /\.(test|d)\.ts$/.test(entry.name)) return [];
    if (["schema.ts", "auth.config.ts", "convex.config.ts"].includes(entry.name)) return [];
    return [path];
  });
}

async function local() {
  const found = new Set();
  for (const path of modules(dir)) {
    const module = relative(dir, path).replace(/\.[jt]s$/, "");
    for (const [name, value] of Object.entries(await import(pathToFileURL(path).href))) {
      if (value?.isQuery || value?.isMutation || value?.isAction) found.add(`${module}:${name}`);
    }
  }
  return found;
}

function deployed() {
  const target = process.env.CONVEX_DEPLOY_KEY ? [] : ["--prod"];
  const out = execFileSync("pnpm", ["exec", "convex", "function-spec", ...target], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const { functions } = JSON.parse(out.slice(out.indexOf("{")));
  return new Set(functions
    .filter(fn => fn.functionType !== "HttpAction")
    .map(fn => fn.identifier.replace(/\.js:/, ":")));
}

const mine = await local();
if (process.argv.includes("--local")) {
  console.log([...mine].sort().join("\n"));
  process.exit(0);
}
const theirs = deployed();
const removed = [...theirs].filter(id => !mine.has(id)).sort();
const added = [...mine].filter(id => !theirs.has(id)).sort();
console.log(`${theirs.size} deployed, ${mine.size} in this checkout, ${added.length} to add, ${removed.length} to remove.`);
for (const id of added) console.log(`  + ${id}`);
for (const id of removed) console.log(`  - ${id}`);
if (removed.length && process.env.BEAM_ALLOW_CONVEX_REMOVALS !== "1") {
  console.error(`\nRefusing to deploy: it would remove ${removed.length} function(s) the deployment still serves.`);
  console.error("Bring them into this checkout, or rerun with BEAM_ALLOW_CONVEX_REMOVALS=1 to remove them on purpose.");
  process.exit(1);
}
