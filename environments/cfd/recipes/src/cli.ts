#!/usr/bin/env node
/**
 * beam-recipe: mesh or solve a Beam study in the cfd environment. Beam writes the study's stage and
 * settings to $BEAM_WORK/beam/recipe.json and the inputs it needs (a checked mesh, imported surfaces)
 * beside it; this writes the study's report and files, and Beam's standard results under beam/out.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RECIPE_PATH, SimulationJob, SimulationReport } from "@beam/contracts";
import { runRecipe } from "./openfoam.ts";
import { writeStudyResults } from "./results.ts";

const dir = process.env["BEAM_WORK"] ?? process.cwd(), started = Date.now();
try {
  const sim = SimulationJob.parse(JSON.parse(await readFile(join(dir, RECIPE_PATH), "utf8")));
  await runRecipe(sim, dir);
  const report = SimulationReport.parse(JSON.parse(await readFile(join(dir, "report.json"), "utf8")));
  const manifest = await writeStudyResults(sim, dir, report, started);
  console.log(`beam-recipe: wrote ${manifest.quantities.length} numbers, ${manifest.checks.length} checks and ${manifest.files.length} study files`);
} catch (e) {
  console.error(`beam-recipe: ${(e as Error).message}`);
  process.exit(1);
}
