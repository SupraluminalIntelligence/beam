/**
 * Readers for what OpenFOAM writes as it runs: a solver's log, function-object .dat files, and
 * checkMesh's report. Pure functions over text, so the runner can use them on a chat's machine and the
 * gateway on a cloud job alike. They read what is there and never fail on a partial file: a log being
 * written ends mid-line, and its last step may be incomplete.
 */

export type FoamLog = {
  /** The application, from the log header (simpleFoam, pimpleFoam, foamRun …). */
  solver: string | null;
  /** Each step's time (an iteration number for a steady solver). */
  times: number[];
  /** Initial residual of each field's first solve in each step; null where a field was not solved. */
  residuals: Map<string, (number | null)[]>;
  /** Largest Courant number reported in each step, when the solver reports one. */
  courant: (number | null)[];
  /** The last "sum local" continuity error. */
  continuity: number | null;
  ended: boolean;
  fatal: string | null;
};

const TIME = /^Time = ([-+0-9.eE]+)s?\s*$/;
const SOLVE = /Solving for (\w+), Initial residual = ([-+0-9.eE]+)/;
const COURANT = /^Courant Number mean: [-+0-9.eE]+ max: ([-+0-9.eE]+)/;
const CONTINUITY = /continuity errors : sum local = ([-+0-9.eE]+)/;
const EXEC = /^Exec\s*:\s*(\S+)/;

export function parseFoamLog(text: string): FoamLog {
  const log: FoamLog = { solver: null, times: [], residuals: new Map(), courant: [], continuity: null, ended: false, fatal: null };
  let step = -1, seen = new Set<string>();
  const lines = text.split("\n");
  // A log being written ends mid-line: leave its last line for the next read.
  if (!text.endsWith("\n")) lines.pop();
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (log.solver === null) { const e = EXEC.exec(line); if (e) { log.solver = e[1]!.split("/").pop()!; continue; } }
    const t = TIME.exec(line);
    if (t) {
      const time = Number(t[1]);
      if (!Number.isFinite(time)) continue;
      step = log.times.push(time) - 1;
      log.courant.push(null);
      for (const values of log.residuals.values()) values.push(null);
      seen = new Set();
      continue;
    }
    if (step < 0) continue;
    const s = SOLVE.exec(line);
    if (s) {
      const field = s[1]!, value = Number(s[2]);
      // Later correctors of the same field in one step start from a smaller residual; the first is the step's.
      if (seen.has(field) || !Number.isFinite(value)) continue;
      seen.add(field);
      let values = log.residuals.get(field);
      if (!values) { values = new Array<number | null>(step + 1).fill(null); log.residuals.set(field, values); }
      values[step] = value;
      continue;
    }
    const c = COURANT.exec(line);
    if (c) { const v = Number(c[1]); if (Number.isFinite(v)) log.courant[step] = Math.max(log.courant[step] ?? 0, v); continue; }
    const k = CONTINUITY.exec(line);
    if (k) { const v = Number(k[1]); if (Number.isFinite(v)) log.continuity = v; continue; }
    if (line.trim() === "End") log.ended = true;
    if (line.includes("FOAM FATAL")) log.fatal = line.trim().slice(0, 200);
  }
  return log;
}

export type DatTable = { columns: string[]; rows: (number | string)[][] };

/**
 * A function object's .dat file: comment lines, the last of which names the columns, then whitespace-
 * separated rows. Numbers stay numbers; a column of names (a patch) stays text.
 */
export function parseDat(text: string): DatTable {
  let columns: string[] = [];
  const rows: (number | string)[][] = [];
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const names = line.slice(1).trim().split(/\s+/).filter(Boolean);
      if (names[0] === "Time") columns = names;
      continue;
    }
    const cells = line.split(/\s+/).map(c => { const n = Number(c); return Number.isFinite(n) && c !== "" ? n : c; });
    if (typeof cells[0] === "number") rows.push(cells);
  }
  return { columns, rows };
}

/**
 * One function object's output across restarts: OpenFOAM writes a directory per start time
 * (postProcessing/forceCoeffs/0, /600, …). Rows are joined in time order, a later restart's rows
 * replacing an earlier one's from the time it starts.
 */
export function joinRestarts(parts: { start: number; table: DatTable }[]): DatTable {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const columns = [...sorted].reverse().find(p => p.table.columns.length)?.table.columns ?? [];
  const rows: (number | string)[][] = [];
  for (const { start, table } of sorted) {
    while (rows.length && (rows.at(-1)![0] as number) >= start) rows.pop();
    rows.push(...table.rows);
  }
  return { columns, rows };
}

export type CheckMesh = { cells: number | null; ok: boolean | null; maxNonOrthogonality: number | null; maxSkewness: number | null; maxAspectRatio: number | null; failed: string[] };

export function parseCheckMesh(text: string): CheckMesh {
  const num = (re: RegExp) => { const m = re.exec(text); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) ? v : null; };
  const ok = /^\s*Mesh OK\.?\s*$/m.test(text) ? true : /Failed \d+ mesh checks?/.test(text) ? false : null;
  return {
    cells: num(/^\s*cells:\s+(\d+)/m),
    ok,
    maxNonOrthogonality: num(/Mesh non-orthogonality Max: ([-+0-9.eE]+)/),
    maxSkewness: num(/Max skewness = ([-+0-9.eE]+)/),
    maxAspectRatio: num(/Max aspect ratio[:=]\s*([-+0-9.eE]+)/),
    failed: [...text.matchAll(/^\s*\*{3}(.+)$/gm)].map(m => m[1]!.trim().slice(0, 200)).slice(0, 10),
  };
}
