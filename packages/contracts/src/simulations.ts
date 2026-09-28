import { z } from "zod";
import { JobPath } from "./compute.ts";
import { EnvironmentName, ImageRef } from "./environments.ts";

/**
 * Simulations: the thing being investigated. Each saved version has a setup of one of two kinds:
 * - recipe: a study from the retired Simulation pane (read-only now), a SimulationCase config (simulation.ts);
 * - files: files snapshotted from a thread, declared parameters, an environment and a command.
 * A version is immutable; editing makes the next version. Jobs run a version; results belong to it.
 * Stored in the simulationCases / simulationRevisions tables, which the studies used first.
 */
export const SimulationKind = z.enum(["recipe", "files"]);
export type SimulationKind = z.infer<typeof SimulationKind>;

/** An input a person or agent varies on purpose. Numbers carry a unit ("1" when dimensionless). */
export const Parameter = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Use a name like fillet_radius"),
  value: z.union([z.number().finite(), z.string().max(200), z.boolean()]),
  unit: z.string().max(40).default(""),
  label: z.string().max(120).optional(),
});
export type Parameter = z.infer<typeof Parameter>;
export const Parameters = z.array(Parameter).max(64).superRefine((ps, ctx) => {
  if (new Set(ps.map((p) => p.name)).size !== ps.length) ctx.addIssue({ code: "custom", message: "Parameter names must be unique" });
});

/** Written into every job of a files version at beam/parameters.json; beam_out.parameters() reads it. */
export const PARAMETERS_PATH = "beam/parameters.json";
export function parametersFile(ps: Parameter[]): string {
  return JSON.stringify(Object.fromEntries(ps.map((p) => [p.name, { value: p.value, unit: p.unit }])), null, 1);
}

export const FilesSetup = z.object({
  kind: z.literal("files"),
  environment: z.object({ name: EnvironmentName, image: ImageRef }).strict(),
  /** Run with bash -lc in the job's /work, which holds the files and beam/parameters.json. */
  command: z.string().trim().min(1).max(8000),
  files: z.array(z.object({ path: JobPath, assetId: z.string().min(1).max(128) }).strict()).max(64),
  parameters: Parameters.default([]),
  timeoutSeconds: z.number().int().min(1).max(86400).default(3600),
}).strict().superRefine((s, ctx) => {
  const paths = s.files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Duplicate setup files" });
  if (paths.some((p) => p === "beam" || p.startsWith("beam/"))) ctx.addIssue({ code: "custom", message: "beam/ is reserved for parameters and results" });
});
export type FilesSetup = z.infer<typeof FilesSetup>;

/** What changed between two versions of a files setup, for a person reading a comparison. */
export function setupChanges(before: FilesSetup, after: FilesSetup) {
  const changes: string[] = [];
  const params = (s: FilesSetup) => new Map(s.parameters.map((p) => [p.name, p]));
  const a = params(before), b = params(after);
  for (const [name, p] of b) {
    const old = a.get(name);
    if (!old) changes.push(`+ ${name} = ${p.value}${p.unit && p.unit !== "1" ? ` ${p.unit}` : ""}`);
    else if (old.value !== p.value || old.unit !== p.unit) changes.push(`${name}: ${old.value}${old.unit && old.unit !== "1" ? ` ${old.unit}` : ""} → ${p.value}${p.unit && p.unit !== "1" ? ` ${p.unit}` : ""}`);
  }
  for (const name of a.keys()) if (!b.has(name)) changes.push(`− ${name}`);
  const files = (s: FilesSetup) => new Map(s.files.map((f) => [f.path, f.assetId]));
  const fa = files(before), fb = files(after);
  for (const [path, asset] of fb) if (!fa.has(path)) changes.push(`+ ${path}`); else if (fa.get(path) !== asset) changes.push(`~ ${path}`);
  for (const path of fa.keys()) if (!fb.has(path)) changes.push(`− ${path}`);
  if (before.environment.image !== after.environment.image) changes.push(`environment ${before.environment.name} → ${after.environment.name}`);
  if (before.command !== after.command) changes.push("command changed");
  return changes;
}

/** A sweep: the base setup once per value of one parameter, everything else unchanged. */
export function sweepSetups(base: FilesSetup, name: string, values: (number | string | boolean)[]): FilesSetup[] {
  const p = base.parameters.find((x) => x.name === name);
  if (!p) throw new Error(`The setup has no parameter ${name}`);
  if (!values.length || values.length > 32) throw new Error("Sweep 1 to 32 values");
  return values.map((value) => FilesSetup.parse({ ...base, parameters: base.parameters.map((x) => (x.name === name ? { ...x, value } : x)) }));
}
