import { z } from "zod";

/**
 * Environments: what is installed on a machine. A built-in environment is an image built from
 * environments/<name> in this repo, validated by its benchmarks; a custom one is a team's own image.
 * Jobs always name an image by digest, so a result can be reproduced exactly.
 */
export const EnvironmentName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "Use lower-case letters, digits and '-'");
export type EnvironmentName = z.infer<typeof EnvironmentName>;

/** registry/path@sha256:<64 hex>. Tags move, so jobs never use one. */
export const ImageRef = z.string().max(300).regex(
  /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/,
  "Name the image by digest: registry/path@sha256:…",
);
export type ImageRef = z.infer<typeof ImageRef>;
export const Platform = z.enum(["linux/amd64", "linux/arm64"]);

/** Built-in: available once its smoke tests pass, validated once agents reliably solve its benchmarks. Custom: unverified until it has benchmarks. */
export const EnvironmentStatus = z.enum(["unverified", "available", "validated"]);

/** /beam/env.json inside the image, and environments/<name>/env.json in this repo. */
export const EnvironmentDescription = z.object({
  version: z.literal(1),
  name: EnvironmentName,
  kind: z.enum(["built-in", "custom"]),
  status: EnvironmentStatus,
  summary: z.string().min(1).max(300),
  tools: z.array(z.string().max(80)).max(64),
  /** Path of the agent guide inside the image. */
  guide: z.string().startsWith("/").max(200),
  packages: z.string().startsWith("/").max(200).optional(),
  benchmarks: z.array(z.object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/),
    command: z.string().min(1).max(2000),
    compares: z.string().max(300),
  })).max(32).default([]),
}).superRefine((e, ctx) => {
  if (e.kind === "custom" && e.status === "validated" && !e.benchmarks.length)
    ctx.addIssue({ code: "custom", message: "A custom environment needs benchmarks before it can be validated" });
});
export type EnvironmentDescription = z.infer<typeof EnvironmentDescription>;

/** One published build of an environment. */
export const EnvironmentBuild = z.object({
  name: EnvironmentName,
  image: ImageRef,
  platforms: z.array(Platform).min(1),
  description: EnvironmentDescription,
  builtAt: z.number().int().positive(),
});
export type EnvironmentBuild = z.infer<typeof EnvironmentBuild>;

/**
 * Built-in environments Beam offers, each pinned to the image CI built, benchmarked and published from
 * environments/<name> (.github/workflows/environments.yml). Update a digest only to a build whose
 * benchmarks passed.
 */
/** A cfd image of Beam's own, which may run study recipes (beam-recipe). */
export const isCfdImage = (image: string) => /^ghcr\.io\/supraluminalintelligence\/beam-env-cfd@sha256:[0-9a-f]{64}$/.test(image);
/** `studies`: the image carries Beam's study recipes, so runners run the Simulation pane's studies in it. */
export const BUILT_IN_ENVIRONMENTS: readonly { name: EnvironmentName; image: ImageRef; summary: string; studies?: true }[] = [
  { name: "fea", image: "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:f17cf0e03c9e613d4f653cfbd2a2fbd4ad3d3291ad38e78bd7c8dbe0a6815c5e", summary: "Structures and heat in solids: FEniCSx, PETSc/MUMPS, MPICH, gmsh, pyvista." },
  { name: "cfd", image: "ghcr.io/supraluminalintelligence/beam-env-cfd@sha256:9efe6091607b2c245a7358eb5fdd923a293a8b396e011f89536653607b31d802", summary: "Flow: OpenFOAM 2512 (OpenCFD), with the Python base, pyvista, and Beam's study recipes (beam-recipe).", studies: true },
];
