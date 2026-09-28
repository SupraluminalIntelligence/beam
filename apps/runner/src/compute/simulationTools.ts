import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { BeamTool } from "@beam/harness";
import { BUILT_IN_ENVIRONMENTS, compareQuantities, FilesSetup, ImageRef, JobPath, MachineId, Parameter, ResultsManifest, setupChanges, sweepSetups } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { stageInputs } from "./tools.ts";

const environmentOf = (raw: string) => {
  const builtIn = BUILT_IN_ENVIRONMENTS.find(e => e.name === raw);
  if (builtIn) return { name: builtIn.name, image: builtIn.image };
  const image = ImageRef.safeParse(raw);
  if (image.success) return { name: "custom", image: image.data };
  throw new Error(`Unknown environment ${raw}. Use one from environment_list, or a custom image by digest.`);
};

/**
 * Tools for files simulations: save a version (files snapshotted from the thread, parameters, an
 * environment and a command), run a version as a job, sweep a parameter, compare versions' results.
 * Recipe simulations (the Simulation pane's OpenFOAM studies) keep save_simulation and run_simulation.
 */
export function simulationTools(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, permissionMode: string): BeamTool[] {
  const writable = () => { if (permissionMode === "plan") throw new Error("Plan mode cannot save or run simulations"); };
  // Outside auto mode a job waits for the person; an agent that polls for that holds the turn open for nothing.
  const next = (then: string) => permissionMode === "auto" ? then
    : "Each job waits for the person who asked to approve it (the simulation's Jobs tab, or Approve all). Do not wait or poll for that: end your turn now, saying which jobs need approving and what you found so far. They will @mention you once the jobs have run.";
  const state = () => client.query(api.simulations.forRun, { token, runId });
  const find = async (id: string) => {
    const sim = (await state()).simulations.find(s => s.id === id);
    if (!sim) throw new Error("No simulation with that id in this chat; read list_simulations");
    return sim;
  };
  const versionOf = async (id: string, version: number) => {
    const v = (await find(id)).versions.find(x => x.version === version);
    if (!v?.setup) throw new Error(`No files v${version} of this simulation`);
    return v.setup;
  };
  const save = (a: { id?: string | undefined; version?: number | undefined; from?: number | undefined; name: string; setup: FilesSetup; note?: string | undefined }) =>
    client.mutation(api.simulations.saveVersionForRun, { token, runId, name: a.name, setup: a.setup, ...(a.id ? { id: a.id as Id<"simulationCases"> } : {}), ...(a.version !== undefined ? { version: a.version } : {}), ...(a.from !== undefined ? { from: a.from } : {}), ...(a.note ? { note: a.note } : {}) });
  const run = (id: string, version: number, machine: string, requestKey: string) =>
    client.mutation(api.simulations.runVersionForRun, { token, runId, id: id as Id<"simulationCases">, version, machine, requestKey });

  return [
    {
      name: "save_version",
      description: "Create a simulation, or save its next version, from files in this thread's directory. A version is an immutable snapshot of: the files (up to 64, 20 MB each), declared parameters with units (the inputs you or the team will vary: they are written to beam/parameters.json in every job and read with beam_out.parameters()), an environment, and the command a job runs (bash -lc in /work). Save before running, and save again for every change, so each result is traceable to exactly what produced it. Omit id to create a simulation (it opens a card in the chat and becomes the chat's working simulation); pass id and the current version to save the next one. Write a short note saying what changed and why. Unchanged setups save nothing. Unavailable in plan mode.",
      schema: {
        id: z.string().optional(), version: z.number().int().positive().optional(), name: z.string().min(1).max(100),
        environment: z.string(), command: z.string().min(1).max(8000), files: z.array(JobPath).max(64),
        parameters: z.array(Parameter).max(64).default([]), timeoutSeconds: z.number().int().min(1).max(86400).default(3600),
        note: z.string().max(500).optional(),
      },
      run: async a => {
        writable();
        const paths = z.array(JobPath).max(64).parse(a["files"]);
        const setup = FilesSetup.parse({ kind: "files", environment: environmentOf(String(a["environment"])), command: a["command"], files: await stageInputs(client, token, runId, directory, paths), parameters: a["parameters"] ?? [], timeoutSeconds: a["timeoutSeconds"] ?? 3600 });
        const saved = await save({ id: a["id"] as string | undefined, version: a["version"] as number | undefined, name: String(a["name"]), setup, note: a["note"] as string | undefined });
        return JSON.stringify({ ...saved, next: saved.unchanged ? "Nothing changed; run the existing version." : `run_version with id ${saved.id} and version ${saved.version}.` });
      },
    },
    {
      name: "run_version",
      description: "Run a saved version of a files simulation as a durable job on a machine, and return the job ID immediately. The job's /work holds the version's files and beam/parameters.json; results are what it writes under beam/out. Follow it with get_job; read results with results_read. Reuse requestKey when retrying. In non-auto modes the requester approves first. Machine: only local today.",
      schema: { id: z.string(), version: z.number().int().positive(), machine: MachineId.default("local"), requestKey: z.string().min(1).max(160) },
      run: async a => {
        writable();
        const id = await run(String(a["id"]), Number(a["version"]), String(a["machine"] ?? "local"), String(a["requestKey"]));
        return JSON.stringify({ jobId: id, submitted: true, next: next("Follow it with get_job, then results_read once it succeeds.") });
      },
    },
    {
      name: "sweep",
      description: "Run one simulation version once per value of one declared parameter: saves a new version for each value (everything else unchanged; the base's own value reuses the base version) and submits a job for each. Returns each value's version and job ID. Use for parameter studies and for mesh convergence when mesh size is a parameter (three values refined by a constant ratio give a grid convergence index). Compare the results with compare_versions. Up to 32 values. Unavailable in plan mode.",
      schema: { id: z.string(), version: z.number().int().positive(), parameter: z.string(), values: z.array(z.union([z.number().finite(), z.string(), z.boolean()])).min(1).max(32), machine: MachineId.default("local"), requestKey: z.string().min(1).max(120) },
      run: async a => {
        writable();
        const id = String(a["id"]), sim = await find(id), from = Number(a["version"]), base = await versionOf(id, from);
        const setups = sweepSetups(base, String(a["parameter"]), a["values"] as (number | string | boolean)[]);
        let current = sim.version;
        const rows = [];
        for (const [i, setup] of setups.entries()) {
          const value = (a["values"] as unknown[])[i];
          // The base's own value runs the base version rather than saving a copy of it.
          const version = setupChanges(base, setup).length === 0 ? from
            : (current = (await save({ id, version: current, from, name: sim.name, setup, note: `Sweep ${String(a["parameter"])} = ${String(value)}` })).version);
          rows.push({ value, version, jobId: await run(id, version, String(a["machine"] ?? "local"), `${String(a["requestKey"])}-${i}`) });
        }
        return JSON.stringify({ parameter: a["parameter"], runs: rows, next: next("Follow the jobs with get_job, then compare_versions with their job IDs.") });
      },
    },
    {
      name: "compare_versions",
      description: "Compare the results of two to eight succeeded jobs of one files simulation: every number matched by name and unit against the first job (never converting units), each job's checks, and what changed in the setup between their versions. Use after a change or a sweep, and report the differences with the checks that need review.",
      schema: { jobIds: z.array(z.string()).min(2).max(8) },
      run: async a => {
        const ids = z.array(z.string()).min(2).max(8).parse(a["jobIds"]);
        const jobs = await Promise.all(ids.map(id => client.query(api.compute.forRun, { token, runId, id: id as Id<"computeJobs"> })));
        const loaded = jobs.map((job, i) => {
          if (Array.isArray(job) || job.spec.kind !== "environment" || !job.spec.simulation) throw new Error(`${ids[i]} is not a simulation job`);
          if (job.state !== "succeeded" || !job.results?.manifest) throw new Error(`${ids[i]} has no results (state ${job.state})`);
          return { jobId: ids[i]!, caseId: job.spec.simulation.caseId, version: job.spec.simulation.version, manifest: ResultsManifest.parse(job.results.manifest) };
        });
        if (new Set(loaded.map(l => l.caseId)).size > 1) throw new Error("Compare jobs of one simulation");
        const sim = await find(loaded[0]!.caseId), setup = (v: number) => sim.versions.find(x => x.version === v)?.setup ?? null;
        const base = loaded[0]!;
        return JSON.stringify({
          simulation: sim.name,
          baseline: { jobId: base.jobId, version: base.version, checks: base.manifest.checks },
          others: loaded.slice(1).map(o => {
            const before = setup(base.version), after = setup(o.version);
            return { jobId: o.jobId, version: o.version, setupChanges: before && after ? setupChanges(before, after) : null, quantities: compareQuantities(base.manifest, o.manifest), checks: o.manifest.checks };
          }),
        });
      },
    },
  ];
}
