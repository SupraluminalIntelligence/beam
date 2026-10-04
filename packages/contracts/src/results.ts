import { z } from "zod";
import { ExecutorUnavailable, JobPath, MAX_COMPUTE_FILE_BYTES } from "./compute.ts";

/**
 * Results: what a job writes to beam/out/. manifest.json names every other file by a path relative to
 * beam/out. Written by environments/base/beam_out; read by the gateway (which uploads exactly the files
 * the manifest names), Convex (which keeps the manifest and small items) and the Results views.
 *
 * The manifest only grows: new optional keys and new result kinds may be added; nothing is renamed,
 * removed or retyped, and enum values are never added to (a reader would reject them). Readers ignore
 * keys they do not know, so an older app still reads a newer manifest.
 */
export const RESULTS_MANIFEST_VERSION = 1 as const;
export const RESULTS_ROOT = "beam/out";

const Name = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/, "Use letters, digits, '.', '_' or '-'");
const Label = z.string().max(200);
const Unit = z.string().max(40);
const Finite = z.number().finite();
/** A plot line: display text, also what overlays match on across versions. */
const LineName = z.string().trim().min(1).max(80);
const Count = z.number().int().nonnegative();

/** A number with its unit. The unit "1" means dimensionless. */
export const ResultQuantity = z.object({
  name: Name,
  label: Label,
  value: Finite,
  unit: Unit,
  headline: z.boolean().default(false),
  uncertainty: z.object({ kind: z.enum(["gci", "std", "range"]), relative: Finite.nonnegative().optional(), absolute: Finite.nonnegative().optional() }).optional(),
  reference: z.object({ value: Finite, source: z.string().max(200) }).optional(),
});
export type ResultQuantity = z.infer<typeof ResultQuantity>;

export const CheckStatus = z.enum(["pass", "review", "fail", "not-evaluated"]);
export type CheckStatus = z.infer<typeof CheckStatus>;
/** A claim about how far to trust a result, and the evidence for it. */
export const ResultCheck = z.object({
  id: Name,
  label: Label,
  status: CheckStatus,
  stage: z.enum(["setup", "mesh", "solve", "post"]),
  value: z.string().max(200).optional(),
  criterion: z.string().max(200).optional(),
  detail: z.string().max(2000).optional(),
});
export type ResultCheck = z.infer<typeof ResultCheck>;

/**
 * A plot: x against one or more lines. The values live in a SeriesData file. `overlay` draws it on the
 * plot of another series with the same axes (a result over its reference data); that series is not
 * itself an overlay. Without it, each series is a plot of its own.
 */
export const ResultSeries = z.object({
  name: Name,
  label: Label,
  data: JobPath,
  points: Count,
  kind: z.enum(["line", "polar"]).default("line"),
  x: z.object({ label: Label, unit: Unit.default("") }),
  y: z.object({ unit: Unit.default(""), scale: z.enum(["linear", "log"]).default("linear"), lines: z.array(LineName).min(1).max(32) }),
  overlay: Name.optional(),
});
export type ResultSeries = z.infer<typeof ResultSeries>;
/** What two series must share to be drawn on one plot. */
export const seriesAxes = (s: Pick<ResultSeries, "kind" | "x" | "y">) => [s.kind, s.x.label, s.x.unit, s.y.unit, s.y.scale].join("\u0000");
export const SeriesData = z.object({
  x: z.array(Finite),
  lines: z.array(z.object({ name: LineName, values: z.array(Finite) })).min(1).max(32),
}).superRefine((d, ctx) => {
  if (d.lines.some((l) => l.values.length !== d.x.length)) ctx.addIssue({ code: "custom", message: "Every line needs one value per x" });
});
export type SeriesData = z.infer<typeof SeriesData>;

/** 3D: the full data for ParaView, and a bounded preview the browser draws. */
export const ResultField = z.object({
  name: Name,
  label: Label,
  full: JobPath,
  preview: JobPath,
  cells: Count,
  arrays: z.array(z.object({ name: Name, unit: Unit })).max(32),
});
export type ResultField = z.infer<typeof ResultField>;

export const StepKind = z.enum(["time", "iteration", "load-step", "frequency", "mode", "parameter"]);
export const PREVIEW_LIMITS = { triangles: 500_000, segments: 500_000, parts: 16, steps: 120, bytes: 25 * 1024 * 1024 } as const;
/** A run of triangles or line segments, as [first, count]. */
const Run = z.tuple([Count, Count]);
/**
 * The browser's copy of a field: a triangulated surface with per-vertex arrays, as little-endian
 * Float32 (positions, arrays) and Uint32 (indices) files, triangles wound outward. A stepped array
 * stores `saved` frames, frame-major, then vertex, then component; `values` holds the saved frames'
 * values, spread over the `total` the run wrote (older previews list every value and saved the first).
 *
 * A flow scene adds line segments (streamlines: Uint32 vertex pairs sharing the same vertices and
 * arrays) and names its parts (walls, slices, streamlines) as runs of triangles and segments, so each
 * can be shown or hidden. A value that belongs to a cell is drawn flat by giving each of its triangles
 * vertices of their own. An app that predates segments and parts draws the triangles alone.
 */
export const FieldPreview = z.object({
  version: z.literal(1),
  kind: z.literal("surface"),
  vertices: Count,
  triangles: Count.max(PREVIEW_LIMITS.triangles),
  positions: JobPath,
  indices: JobPath,
  arrays: z.array(z.object({
    name: Name,
    unit: Unit,
    components: z.union([z.literal(1), z.literal(3)]),
    association: z.literal("point"),
    range: z.tuple([Finite, Finite]),
    data: JobPath,
  })).max(32),
  steps: z.object({ kind: StepKind, values: z.array(Finite), unit: Unit.default(""), saved: Count.max(PREVIEW_LIMITS.steps), total: Count }).optional(),
  segments: z.object({ count: Count.max(PREVIEW_LIMITS.segments), indices: JobPath }).optional(),
  parts: z.array(z.object({
    name: Name,
    label: Label,
    triangles: Run.optional(),
    segments: Run.optional(),
    /** How opaque to draw its triangles at first, 0–1: walls that enclose the flow start see-through. */
    opacity: z.number().min(0).max(1).optional(),
  })).max(PREVIEW_LIMITS.parts).optional(),
}).superRefine((p, ctx) => {
  for (const part of p.parts ?? []) {
    const [t0, tn] = part.triangles ?? [0, 0], [s0, sn] = part.segments ?? [0, 0];
    if (t0 + tn > p.triangles || s0 + sn > (p.segments?.count ?? 0)) ctx.addIssue({ code: "custom", message: `Part ${part.name} runs past the preview's triangles or segments` });
  }
});
export type FieldPreview = z.infer<typeof FieldPreview>;

/** Byte length each preview file must have, so a truncated upload is caught before drawing. */
export function previewByteLengths(p: FieldPreview): Record<string, number> {
  const frames = p.steps ? p.steps.saved : 1;
  const sizes: Record<string, number> = { [p.positions]: p.vertices * 3 * 4, [p.indices]: p.triangles * 3 * 4 };
  if (p.segments) sizes[p.segments.indices] = p.segments.count * 2 * 4;
  for (const a of p.arrays) sizes[a.data] = frames * p.vertices * a.components * 4;
  return sizes;
}

export const ResultTable = z.object({ name: Name, label: Label, data: JobPath, rows: Count });
export type ResultTable = z.infer<typeof ResultTable>;
export const TableData = z.object({
  columns: z.array(z.object({ name: z.string().max(80), unit: Unit.optional() })).min(1).max(64),
  rows: z.array(z.array(z.union([Finite, z.string().max(500), z.null()]))).max(10_000),
}).superRefine((t, ctx) => {
  if (t.rows.some((r) => r.length !== t.columns.length)) ctx.addIssue({ code: "custom", message: "Every row needs one cell per column" });
});
export type TableData = z.infer<typeof TableData>;

/** Anything else: CAD, pictures, raw solver output. */
export const ResultFile = z.object({ path: JobPath, label: Label, kind: z.enum(["file", "geometry", "image"]), bytes: Count });
export type ResultFile = z.infer<typeof ResultFile>;

/** A named arrangement of results. Presentation only: changing it never changes a result. */
export const ResultView = z.object({
  name: z.string().min(1).max(80),
  field: Name.optional(),
  color: Name.optional(),
  warp: Name.optional(),
  plot: Name.optional(),
  table: Name.optional(),
});
export type ResultView = z.infer<typeof ResultView>;

/** Where a result came from. The executor records the authoritative copy on the job; this is the job's own account. */
export const ResultProvenance = z.object({
  environment: z.string().max(80).optional(),
  image: z.string().max(300).optional(),
  arch: z.string().max(40).optional(),
  cpus: Count.nullable().optional(),
  command: z.string().max(8000).nullable().optional(),
  wallSeconds: Finite.nonnegative().optional(),
  writtenAt: z.string().max(40).optional(),
});

export const ResultsManifest = z.object({
  version: z.literal(RESULTS_MANIFEST_VERSION),
  provenance: ResultProvenance.default({}),
  quantities: z.array(ResultQuantity).max(200).default([]),
  checks: z.array(ResultCheck).max(100).default([]),
  series: z.array(ResultSeries).max(50).default([]),
  fields: z.array(ResultField).max(20).default([]),
  tables: z.array(ResultTable).max(20).default([]),
  files: z.array(ResultFile).max(64).default([]),
  views: z.array(ResultView).max(20).default([]),
}).superRefine((m, ctx) => {
  const kinds = { quantities: m.quantities.map((q) => q.name), checks: m.checks.map((c) => c.id), series: m.series.map((s) => s.name), fields: m.fields.map((f) => f.name), tables: m.tables.map((t) => t.name) };
  for (const [kind, names] of Object.entries(kinds))
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: `Duplicate names in ${kind}` });
  const paths = resultPaths(m);
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Two results name the same file" });
  for (const v of m.views) {
    if (v.field && !kinds.fields.includes(v.field)) ctx.addIssue({ code: "custom", message: `View ${v.name} names a missing field ${v.field}` });
    if (v.plot && !kinds.series.includes(v.plot)) ctx.addIssue({ code: "custom", message: `View ${v.name} names a missing plot ${v.plot}` });
    if (v.table && !kinds.tables.includes(v.table)) ctx.addIssue({ code: "custom", message: `View ${v.name} names a missing table ${v.table}` });
    const arrays = m.fields.find((f) => f.name === v.field)?.arrays.map((a) => a.name) ?? [];
    for (const a of [v.color, v.warp]) if (a && v.field && !arrays.includes(a)) ctx.addIssue({ code: "custom", message: `View ${v.name} names a missing array ${a}` });
  }
  for (const s of m.series) {
    if (s.overlay === undefined) continue;
    const base = m.series.find((b) => b.name === s.overlay);
    if (!base || base === s || base.overlay !== undefined) ctx.addIssue({ code: "custom", message: `Series ${s.name} overlays ${s.overlay}, which is missing, itself or an overlay` });
    else if (seriesAxes(base) !== seriesAxes(s)) ctx.addIssue({ code: "custom", message: `Series ${s.name} overlays ${s.overlay}, whose axes differ (kind, x label and unit, y unit and scale)` });
  }
});
export type ResultsManifest = z.infer<typeof ResultsManifest>;

/** Every file the manifest names directly, relative to beam/out. Previews name more files; see previewByteLengths. */
export function resultPaths(m: Pick<ResultsManifest, "series" | "fields" | "tables" | "files">): string[] {
  return [...m.series.map((s) => s.data), ...m.fields.flatMap((f) => [f.full, f.preview]), ...m.tables.map((t) => t.data), ...m.files.map((f) => f.path)];
}

/** The numbers a card shows: the ones marked headline, else the first three. */
export function headlineQuantities(m: Pick<ResultsManifest, "quantities">, max = 3): ResultQuantity[] {
  const marked = m.quantities.filter((q) => q.headline);
  return (marked.length ? marked : m.quantities).slice(0, max);
}

export function checkCounts(m: Pick<ResultsManifest, "checks">): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, review: 0, fail: 0, "not-evaluated": 0 };
  for (const c of m.checks) counts[c.status]++;
  return counts;
}

export type QuantityComparison = { name: string; label: string; unit: string; before: number; after: number; delta: number; relative: number | null };
/**
 * Numbers from two versions, matched by name and unit. A quantity whose unit changed is not
 * comparable and is listed as only in one version each, never converted.
 */
export function compareQuantities(before: Pick<ResultsManifest, "quantities">, after: Pick<ResultsManifest, "quantities">) {
  const key = (q: ResultQuantity) => `${q.name}\u0000${q.unit}`;
  const old = new Map(before.quantities.map((q) => [key(q), q]));
  const matched: QuantityComparison[] = [];
  const onlyAfter: ResultQuantity[] = [];
  for (const q of after.quantities) {
    const b = old.get(key(q));
    if (!b) { onlyAfter.push(q); continue; }
    old.delete(key(q));
    matched.push({ name: q.name, label: q.label, unit: q.unit, before: b.value, after: q.value, delta: q.value - b.value, relative: b.value === 0 ? null : (q.value - b.value) / Math.abs(b.value) });
  }
  return { matched, onlyBefore: [...old.values()], onlyAfter };
}

export type CollectedResults = { manifest: ResultsManifest | null; files: { path: string; bytes: Uint8Array }[]; unpublished: { path: string; reason: string }[] };
/** An environment job publishes at most this many files from beam/out, the manifest included; the rest are listed as unpublished. */
export const MAX_RESULT_FILES = 128;
export type CollectOptions = {
  /** Called with each file as it is read and checked, so a caller can publish it before the next is read. Without it, files are returned. */
  onFile?: (file: { path: string; bytes: Uint8Array }) => Promise<void>;
  /** What happens to a file over the size limit: on the engineer's computer it stays there; a cloud machine is released. */
  oversize?: string;
  /**
   * Publishes a file over the size limit somewhere else (the large-output store), given the length its
   * preview says it has, if it is a preview buffer. It resolves with whether the file was published, or
   * why not; it throws ResultRejected for a file that fails the job (a preview buffer of the wrong length).
   */
  large?: (path: string, expectedBytes: number | undefined) => Promise<{ published: true } | { published: false; reason: string }>;
};
/** A result file that fails the job rather than being retried: the viewer would draw garbage. */
export class ResultRejected extends Error {}
/** The message for a preview buffer whose length does not match its description. */
export const previewLengthMismatch = (rel: string, actual: number, expected: number) => `${rel} is ${actual} bytes; its preview says ${expected}`;
/**
 * Everything to publish from beam/out: the manifest and exactly the files it names, previews' buffers
 * included. A file over the size limit, or past the file limit, is listed rather than silently dropped;
 * a preview buffer of the wrong length fails the job, since the viewer would draw garbage.
 */
export async function collectResults(read: (path: string) => Promise<Uint8Array>, options: CollectOptions = {}): Promise<CollectedResults> {
  const manifestPath = `${RESULTS_ROOT}/manifest.json`;
  let manifestBytes: Uint8Array;
  try { manifestBytes = await read(manifestPath); }
  catch (e) { if (/ENOENT|no such file/i.test((e as Error).message)) return { manifest: null, files: [], unpublished: [] }; throw e; }
  const parsed = ResultsManifest.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (!parsed.success) throw new Error(`beam/out/manifest.json is invalid: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const manifest = parsed.data, files: CollectedResults["files"] = [], unpublished: CollectedResults["unpublished"] = [], seen = new Set<string>();
  const keep = async (file: { path: string; bytes: Uint8Array }) => { seen.add(file.path); if (options.onFile) await options.onFile(file); else files.push(file); };
  await keep({ path: manifestPath, bytes: manifestBytes });
  const add = async (rel: string, expectedBytes?: number) => {
    const path = JobPath.parse(`${RESULTS_ROOT}/${rel}`);
    if (seen.has(path) || unpublished.some(u => u.path === path)) return null;
    if (seen.size >= MAX_RESULT_FILES) { unpublished.push({ path, reason: `past the ${MAX_RESULT_FILES}-file limit` }); return null; }
    let bytes: Uint8Array;
    try { bytes = await read(path); }
    catch (e) {
      const message = (e as Error).message;
      if (/20 MB or less|size limit/.test(message)) {
        const large = options.large ? await options.large(path, expectedBytes) : null;
        if (large?.published) { seen.add(path); return null; }
        unpublished.push({ path, reason: large?.reason ?? `larger than ${MAX_COMPUTE_FILE_BYTES / 2 ** 20} MB; ${options.oversize ?? "kept on the machine"}` });
        return null;
      }
      if (e instanceof ExecutorUnavailable) throw e;
      throw new Error(`The manifest names ${rel}, which could not be read: ${message}`);
    }
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) throw new ResultRejected(previewLengthMismatch(rel, bytes.byteLength, expectedBytes));
    await keep({ path, bytes });
    return bytes;
  };
  for (const rel of resultPaths(manifest)) {
    const bytes = await add(rel);
    const field = manifest.fields.find(f => f.preview === rel);
    if (field && bytes) {
      const preview = FieldPreview.parse(JSON.parse(new TextDecoder().decode(bytes)));
      for (const [buffer, size] of Object.entries(previewByteLengths(preview))) await add(buffer, size);
    }
  }
  return { manifest, files, unpublished };
}

/**
 * The command as the container runs it. beam/ lives at the job root whatever directory the command
 * changes to; results written under another directory's beam/out would publish nothing, so say where
 * they went rather than leave the job looking empty.
 */
export const jobScript = (command: string) => [
  `{\n${command}\n}`,
  `status=$?`,
  `if [ ! -f "$BEAM_WORK/${RESULTS_ROOT}/manifest.json" ]; then`,
  `  stray=$(find "$BEAM_WORK" -mindepth 2 -maxdepth 6 -path "*/${RESULTS_ROOT}/manifest.json" 2>/dev/null | head -n 3)`,
  `  if [ -n "$stray" ]; then`,
  `    echo "beam: nothing was published: Beam reads results only from $BEAM_WORK/${RESULTS_ROOT}, but the manifest was written to:" >&2`,
  `    echo "$stray" >&2`,
  `    echo "beam: write results with beam_out, which uses $BEAM_WORK/${RESULTS_ROOT} from any directory, or use absolute paths." >&2`,
  `  fi`,
  `fi`,
  `exit $status`,
].join("\n");

const PREFIXES: [string, number][] = [["G", 1e9], ["M", 1e6], ["k", 1e3], ["", 1], ["m", 1e-3], ["µ", 1e-6], ["n", 1e-9]];
/** SI prefixes that read naturally for each base unit (km is fine, kK is not). */
const PREFIXABLE: Record<string, string[]> = {
  m: ["k", "", "m", "µ", "n"], Pa: ["G", "M", "k", ""], N: ["M", "k", "", "m"], W: ["G", "M", "k", "", "m"], J: ["G", "M", "k", "", "m"],
  s: ["", "m", "µ"], Hz: ["G", "M", "k", ""], V: ["k", "", "m"], A: ["k", "", "m", "µ"],
};
/** A number with its unit, as a person reads it: 4 significant digits, SI prefixes where they read naturally. */
/** The prefixed unit an axis of these values reads best in (µm for 2.4e-4 … 9.5e-4 m), and the factor that converts to it. */
export function siScale(values: number[], unit: string): { unit: string; factor: number } {
  const allowed = PREFIXABLE[unit], a = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
  if (!allowed || a === 0) return { unit, factor: 1 };
  const options = PREFIXES.filter(([p]) => allowed.includes(p)), pick = options.find(([, f]) => a >= f) ?? options.at(-1)!;
  return { unit: `${pick[0]}${unit}`, factor: 1 / pick[1] };
}

export function formatQuantity(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return "—";
  const plain = (v: number) => {
    const a = Math.abs(v);
    if (Number.isInteger(v) && a < 1e6) return v.toLocaleString("en-US");
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(digits - 1).replace(/\.?0+e/, "e").replace("e+", "e");
    return String(Number(v.toPrecision(digits)));
  };
  const allowed = PREFIXABLE[unit];
  if (allowed && value !== 0) {
    const a = Math.abs(value);
    const pick = PREFIXES.filter(([p]) => allowed.includes(p)).find(([, f]) => a >= f) ?? PREFIXES.filter(([p]) => allowed.includes(p)).at(-1)!;
    return `${plain(value / pick[1])} ${pick[0]}${unit}`;
  }
  return unit && unit !== "1" ? `${plain(value)} ${unit}` : plain(value);
}
