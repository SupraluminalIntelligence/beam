import { z } from "zod";

/**
 * Live views: what Beam reads from a solver's own output while it runs, before anything is published.
 * The runner writes one for a simulation's work on the chat's machine (a draft's trial runs, or the next
 * version being prepared); the simulation page draws it in Results until a job's checked results take
 * over. Nothing here is a result: no checks, and the numbers are the solver's latest, not converged values.
 *
 * Small by construction: series are thinned to LIVE_LIMITS.points, so a view stays well inside a
 * Convex document and can be rewritten every few seconds.
 */
export const LIVE_LIMITS = { series: 12, lines: 12, points: 1500, cases: 12, quantities: 24, bytes: 256 * 1024 } as const;

const Finite = z.number().finite();
const Text = (n: number) => z.string().max(n);

export const LiveSeries = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  label: Text(200),
  x: z.object({ label: Text(80), unit: Text(40) }),
  y: z.object({ unit: Text(40), scale: z.enum(["linear", "log"]) }),
  xs: z.array(Finite).max(LIVE_LIMITS.points),
  /** One value per x; null where the line has none (a field not solved at that step). */
  lines: z.array(z.object({ name: Text(80), values: z.array(Finite.nullable()).max(LIVE_LIMITS.points) })).min(1).max(LIVE_LIMITS.lines),
}).superRefine((s, ctx) => {
  if (s.lines.some(l => l.values.length !== s.xs.length)) ctx.addIssue({ code: "custom", message: `Series ${s.name}: every line needs one value per x` });
});
export type LiveSeries = z.infer<typeof LiveSeries>;

/** A solver run Beam found on the machine: an OpenFOAM case directory, by its path under /work. */
export const LiveCase = z.object({
  path: Text(300),
  solver: Text(80).nullable(),
  /** running: its log grew in the last few seconds; done: the solver wrote End; failed: it wrote a fatal error. */
  state: z.enum(["running", "stopped", "done", "failed"]),
  updatedAt: Finite,
});
export type LiveCase = z.infer<typeof LiveCase>;

export const LiveView = z.object({
  version: z.literal(1),
  /** The case drawn, the most recently active one, and every case found, newest first. */
  case: LiveCase,
  cases: z.array(LiveCase).max(LIVE_LIMITS.cases),
  quantities: z.array(z.object({ name: Text(80), label: Text(200), value: Finite, unit: Text(40) })).max(LIVE_LIMITS.quantities),
  /** checkMesh on the case's mesh, when it was run. */
  mesh: z.object({
    cells: z.number().int().nonnegative().nullable(),
    ok: z.boolean().nullable(),
    maxNonOrthogonality: Finite.nullable(),
    maxSkewness: Finite.nullable(),
    maxAspectRatio: Finite.nullable(),
    failed: z.array(Text(200)).max(10),
  }).nullable(),
  series: z.array(LiveSeries).max(LIVE_LIMITS.series),
  /** The command running on the machine now, if any. */
  command: z.object({ text: Text(300), startedAt: Finite }).nullable(),
});
export type LiveView = z.infer<typeof LiveView>;

/** A plot's points thinned to at most `max`, keeping the first and the last. */
export function thinIndices(length: number, max: number = LIVE_LIMITS.points): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const stride = (length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * stride));
}
