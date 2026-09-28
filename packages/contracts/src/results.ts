import { z } from "zod";
import { JobPath, MAX_COMPUTE_FILE_BYTES } from "./compute.ts";

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

/** A plot: x against one or more lines. The values live in a SeriesData file. */
export const ResultSeries = z.object({
  name: Name,
  label: Label,
  data: JobPath,
  points: Count,
  kind: z.enum(["line", "polar"]).default("line"),
  x: z.object({ label: Label, unit: Unit.default("") }),
  y: z.object({ unit: Unit.default(""), scale: z.enum(["linear", "log"]).default("linear"), lines: z.array(LineName).min(1).max(32) }),
});
export type ResultSeries = z.infer<typeof ResultSeries>;
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
export const PREVIEW_LIMITS = { triangles: 500_000, steps: 120, bytes: 25 * 1024 * 1024 } as const;
/**
 * The browser's copy of a field: a triangulated surface with per-vertex arrays, as little-endian
 * Float32 (positions, arrays) and Uint32 (indices) files. A stepped array stores `saved` frames,
 * frame-major, then vertex, then component.
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
});
export type FieldPreview = z.infer<typeof FieldPreview>;

/** Byte length each preview file must have, so a truncated upload is caught before drawing. */
export function previewByteLengths(p: FieldPreview): Record<string, number> {
  const frames = p.steps ? p.steps.saved : 1;
  const sizes: Record<string, number> = { [p.positions]: p.vertices * 3 * 4, [p.indices]: p.triangles * 3 * 4 };
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
/**
 * Everything to publish from beam/out: the manifest and exactly the files it names, previews' buffers
 * included. A file over the size limit stays on the machine and is listed, not silently dropped; a
 * preview buffer of the wrong length fails the job, since the viewer would draw garbage.
 */
export async function collectResults(read: (path: string) => Promise<Uint8Array>): Promise<CollectedResults> {
  const manifestPath = `${RESULTS_ROOT}/manifest.json`;
  let manifestBytes: Uint8Array;
  try { manifestBytes = await read(manifestPath); }
  catch (e) { if (/ENOENT|no such file/i.test((e as Error).message)) return { manifest: null, files: [], unpublished: [] }; throw e; }
  const parsed = ResultsManifest.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (!parsed.success) throw new Error(`beam/out/manifest.json is invalid: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const manifest = parsed.data, files = [{ path: manifestPath, bytes: manifestBytes }], unpublished: CollectedResults["unpublished"] = [];
  const add = async (rel: string, expectedBytes?: number) => {
    const path = JobPath.parse(`${RESULTS_ROOT}/${rel}`);
    if (files.some(f => f.path === path)) return null;
    let bytes: Uint8Array;
    try { bytes = await read(path); }
    catch (e) {
      const message = (e as Error).message;
      if (/20 MB or less|size limit/.test(message)) { unpublished.push({ path, reason: `larger than ${MAX_COMPUTE_FILE_BYTES / 2 ** 20} MB; kept on the machine` }); return null; }
      throw new Error(`The manifest names ${rel}, which could not be read: ${message}`);
    }
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) throw new Error(`${rel} is ${bytes.byteLength} bytes; its preview says ${expectedBytes}`);
    files.push({ path, bytes });
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
