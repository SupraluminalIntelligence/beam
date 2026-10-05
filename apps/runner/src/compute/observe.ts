import { open, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { buildLiveView, datReader, foamLogReader, joinRestarts, type DatTable, type FoamLog } from "@beam/observe";
import type { LiveCase, LiveView } from "@beam/contracts";

/**
 * Watches a thread directory while an agent works on its machine, and reports what the solver itself
 * writes there (logs, function-object output, checkMesh) as a live view. Nothing the agent does is
 * needed: an OpenFOAM case is any directory with system/controlDict, and the view follows the one most
 * recently active.
 */

// Directories that are never cases themselves and hold nothing to look for: a case's own parts, time
// directories, decomposed copies, and tooling.
const SKIP = /^(processor\d+|postProcessing|constant|system|dynamicCode|VTK|\.git|\.beam|beam|node_modules|__pycache__|\.venv|[-+]?\d+(\.\d+)?(e[-+]?\d+)?)$/i;
// Logs of OpenFOAM's utilities rather than its solvers.
const UTILITY = /^(blockMesh|snappyHexMesh|checkMesh|decomposePar|reconstructPar|reconstructParMesh|redistributePar|gmshToFoam|fluentMeshToFoam|ideasUnvToFoam|renumberMesh|setFields|setExprFields|surfaceFeatureExtract|surfaceFeatures|topoSet|createPatch|createBaffles|mapFields|extrudeMesh|extrude2DMesh|transformPoints|refineMesh|foamToVTK|postProcess|foamDictionary|changeDictionary|mirrorMesh|stitchMesh|subsetMesh|splitMeshRegions|potentialFoam)$/;
const RUNNING_MS = 15_000, CHUNK = 4 * 1024 * 1024, HEAD = 512;
// While a command runs, the view is published at least this often, so the page can tell a quiet step
// (a long mesh, a slow first iteration) from work that stopped being watched.
const HEARTBEAT_MS = 60_000;

/** Case directories under root, by their path relative to it. */
export async function findCases(root: string, depth = 5): Promise<string[]> {
  const cases: string[] = [];
  const walk = async (dir: string, left: number) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isDirectory() && e.name === "system") && await stat(join(dir, "system", "controlDict")).then(s => s.isFile(), () => false)) {
      cases.push(relative(root, dir) || ".");
      return;
    }
    if (left <= 0) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.test(e.name)) await walk(join(dir, e.name), left - 1);
  };
  await walk(root, depth);
  return cases;
}

type Reader = { push(text: string): unknown };
/** How far each file has been read, and what was read from it, kept between passes. */
export type Memory = Map<string, { offset: number; head: string; reader: Reader }>;

/**
 * A file's reader, after reading only what the file gained since the last pass, whole lines at a time.
 * A file that shrank or starts differently (rewritten by a new run) is read again from its start.
 */
async function follow<R extends Reader>(memory: Memory, path: string, fresh: () => R): Promise<R> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const first = Buffer.alloc(Math.min(HEAD, size));
    await handle.read(first, 0, first.length, 0);
    const head = first.toString("latin1");
    let f = memory.get(path);
    const n = Math.min(head.length, f?.head.length ?? 0);
    if (!f || size < f.offset || head.slice(0, n) !== f.head.slice(0, n)) memory.set(path, f = { offset: 0, head, reader: fresh() });
    if (head.length > f.head.length) f.head = head;
    while (f.offset < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - f.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, f.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end >= 0) { f.reader.push(buffer.toString("utf8", 0, end + 1)); f.offset += end + 1; }
      // A line longer than a whole chunk is nothing a reader looks for: skip it.
      else if (bytesRead === CHUNK) f.offset += bytesRead;
      // The rest is a line still being written.
      else break;
    }
    return f.reader as R;
  } finally { await handle.close(); }
}

/** The last maxBytes of a file, from the start of a line. */
async function tail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat(), start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await handle.close(); }
}

type Stamped = { path: string; size: number; mtime: number };
const stamp = async (path: string): Promise<Stamped | null> => stat(path).then(s => (s.isFile() ? { path, size: s.size, mtime: s.mtimeMs } : null), () => null);

/** What a case holds: its logs, its function objects' .dat files by start time, and whether it has a mesh. */
async function inventory(dir: string) {
  const logs: Stamped[] = [], dats: (Stamped & { object: string; start: number })[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) if (name.startsWith("log.")) { const s = await stamp(join(dir, name)); if (s) logs.push(s); }
  const pp = join(dir, "postProcessing");
  for (const object of await readdir(pp).catch(() => [] as string[])) {
    for (const start of await readdir(join(pp, object)).catch(() => [] as string[])) {
      const t = Number(start);
      if (!Number.isFinite(t)) continue;
      for (const file of await readdir(join(pp, object, start)).catch(() => [] as string[])) {
        if (!file.endsWith(".dat")) continue;
        const s = await stamp(join(pp, object, start, file));
        if (s) dats.push({ ...s, object, start: t });
      }
    }
  }
  const mesh = !!(await stamp(join(dir, "constant", "polyMesh", "owner")) ?? await stamp(join(dir, "constant", "polyMesh", "owner.gz")));
  const solverLog = logs.filter(l => !UTILITY.test(basename(l.path).slice(4))).sort((a, b) => b.mtime - a.mtime)[0] ?? null;
  const updatedAt = Math.max(0, ...logs.map(l => l.mtime), ...dats.map(d => d.mtime));
  return { logs, dats, mesh, solverLog, updatedAt };
}

/** Function-object output by kind: force coefficients and y+, each joined across restarts. */
async function objects(dats: (Stamped & { object: string; start: number })[], memory: Memory): Promise<Record<string, DatTable>> {
  const kinds: Record<string, string> = { "coefficient.dat": "forceCoeffs", "forceCoeffs.dat": "forceCoeffs", "yPlus.dat": "yPlus" };
  const out: Record<string, DatTable> = {};
  for (const [file, kind] of Object.entries(kinds)) {
    const parts = dats.filter(d => basename(d.path) === file);
    if (!parts.length || out[kind]) continue;
    // One function object of a kind: the one written most recently.
    const object = parts.sort((a, b) => b.mtime - a.mtime)[0]!.object;
    out[kind] = joinRestarts(await Promise.all(parts.filter(p => p.object === object).map(async p => ({ start: p.start, table: (await follow(memory, p.path, datReader)).table }))));
  }
  return out;
}

function caseState(log: FoamLog | null, mtime: number, now: number): LiveCase["state"] {
  if (log?.fatal) return "failed";
  if (log?.ended) return "done";
  return now - mtime < RUNNING_MS ? "running" : "stopped";
}

/**
 * One reading of the thread directory, or null when no case there has a mesh or a solver log yet. Pass
 * the same memory to each reading and only what the files gained since is read.
 */
export async function readMachine(root: string, command: LiveView["command"], now = Date.now(), memory: Memory = new Map()): Promise<{ view: LiveView; fingerprint: string } | null> {
  const found = await Promise.all((await findCases(root)).map(async path => ({ path, inv: await inventory(join(root, path)) })));
  const real = found.filter(c => c.inv.mesh || c.inv.solverLog).sort((a, b) => b.inv.updatedAt - a.inv.updatedAt);
  if (!real.length) return null;
  const top = real[0]!, log = top.inv.solverLog ? (await follow(memory, top.inv.solverLog.path, foamLogReader)).log : null;
  const checkMesh = top.inv.logs.find(l => basename(l.path) === "log.checkMesh");
  const brief = (c: typeof real[number], log: FoamLog | null): LiveCase => ({
    path: c.path, solver: c.inv.solverLog ? basename(c.inv.solverLog.path).slice(4) : null,
    state: caseState(log, c.inv.solverLog?.mtime ?? c.inv.updatedAt, now), updatedAt: c.inv.updatedAt || now,
  });
  // While a command runs on the machine, the case it last touched is its work, even between log writes.
  const seen = brief(top, log), current = command && seen.state === "stopped" ? { ...seen, state: "running" as const } : seen;
  const view = buildLiveView({
    case: current,
    cases: [current, ...real.slice(1).map(c => brief(c, null))],
    log, objects: await objects(top.inv.dats, memory),
    checkMesh: checkMesh ? await tail(checkMesh.path, 256 * 1024) : null,
    command,
  });
  const fingerprint = JSON.stringify([real.map(c => [c.path, c.inv.updatedAt, c.inv.mesh]), top.inv.logs.map(l => [l.path, l.size, l.mtime]), top.inv.dats.map(d => [d.path, d.size, d.mtime]), command, current.state, command ? Math.floor(now / HEARTBEAT_MS) : 0]);
  return { view, fingerprint };
}

/**
 * Reads the thread directory every few seconds while an agent works and publishes the view when it
 * changes. A failed reading or publish is logged and retried on the next pass; it never stops the run.
 */
export function observeMachine(root: string, publish: (view: LiveView) => Promise<unknown>, command: () => LiveView["command"], log: (message: string) => void = () => {}, intervalMs = 4000) {
  let last = "", busy: Promise<void> | null = null, stopped = false, quiet = false;
  const memory: Memory = new Map();
  const pass = async () => {
    try {
      const reading = await readMachine(root, command(), Date.now(), memory);
      if (!reading || reading.fingerprint === last) return;
      await publish(reading.view);
      last = reading.fingerprint;
      quiet = false;
    } catch (e) {
      if (!quiet) log(`machine view: ${(e as Error).message}`);
      quiet = true;
    }
  };
  const tick = () => { if (!busy && !stopped) busy = pass().finally(() => { busy = null; }); };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    /** One last reading, so the view shows how the work ended, then stop. */
    async stop() {
      clearInterval(timer);
      if (busy) await busy;
      if (!stopped) { stopped = true; await pass(); }
    },
  };
}
