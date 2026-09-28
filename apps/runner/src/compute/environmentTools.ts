import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { BeamTool } from "@beam/harness";
import { BUILT_IN_ENVIRONMENTS, EnvironmentJobSpec, EnvironmentName, ImageRef, JobPath, MACHINES, MachineId, ResultsManifest, checkCounts, headlineQuantities } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { closeLocalMachine, environmentAvailable, execOnLocalMachine, openLocalMachine } from "./environment.ts";
import { stageInputs } from "./tools.ts";

/** An environment by name (built-in) or by digest (custom). */
function resolveEnvironment(raw: string) {
  const builtIn = BUILT_IN_ENVIRONMENTS.find(e => e.name === raw);
  if (builtIn) return builtIn;
  const image = ImageRef.safeParse(raw);
  if (image.success) return { name: "custom", image: image.data, summary: "Custom environment" };
  throw new Error(`Unknown environment ${raw}. Use one from environment_list, or a custom image by digest (registry/path@sha256:…).`);
}
const installed = (image: string) => environmentAvailable(image).then(() => true, () => false);

/**
 * Tools for running physics tools in environments: a chat machine for trying things in seconds, and
 * durable jobs whose results (beam/out) are published to the chat. See docs/decisions/2026-09-27-compute-plane.md.
 */
export function environmentTools(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, permissionMode: string): BeamTool[] {
  const writable = () => { if (permissionMode === "plan") throw new Error("Plan mode cannot run commands on a machine"); };
  return [
    {
      name: "environment_list",
      description: "List the environments (pinned images of physics and engineering tools) and machines available to this chat. Each environment ships a guide at /beam/env.md with installed tools, a worked example and known gotchas: read it (machine_open returns it) before writing a setup. Only the local machine (this computer's Docker) is available today; cloud machines are listed for planning.",
      schema: {},
      run: async () => JSON.stringify({
        environments: await Promise.all(BUILT_IN_ENVIRONMENTS.map(async e => ({ ...e, installedOnThisComputer: await installed(e.image) }))),
        machines: Object.values(MACHINES).map(m => ({ id: m.id, label: m.label, cores: m.cores, memoryGiB: m.memoryGiB, gpus: m.gpus, available: m.id === "local" })),
        next: "machine_open with an environment, then machine_exec to try commands; job_submit for the full run.",
      }),
    },
    {
      name: "machine_open",
      description: "Start (or reuse) this chat's machine with an environment. On the local machine it is a container on this computer with this thread's working directory mounted at /work, no network, and all of Docker's CPUs; it stops itself after 30 idle minutes. Returns the environment's guide (/beam/env.md) and the core count ($BEAM_CORES, for mpirun -n). Opening another environment replaces the machine. Files you write under /work appear in the thread directory; results written there are not published: submit a job for results the chat can see.",
      schema: { environment: z.string().describe("A name from environment_list, or a custom image by digest") },
      run: async a => {
        writable();
        const env = resolveEnvironment(String(a["environment"]));
        const machine = await openLocalMachine(directory, env.image, directory);
        const guide = await execOnLocalMachine(directory, "cat /beam/env.md 2>/dev/null || echo 'This environment has no /beam/env.md.'", 30);
        return JSON.stringify({ machine: "local", environment: env.name, image: env.image, cores: machine.cpus, started: machine.started, workdir: "/work (this thread's working directory)", guide: guide.stdout });
      },
    },
    {
      name: "machine_exec",
      description: "Run a shell command (bash -lc) on this chat's machine in /work and return its exit code, stdout and stderr (last 16,000 characters each). For short steps: meshing, a coarse solve, reading a log, checking results. Anything longer than a few minutes, or anything whose results the chat should see, belongs in job_submit. The machine has no network. Unavailable in plan mode.",
      schema: { command: z.string().min(1).max(8000), timeoutSeconds: z.number().int().min(1).max(600).default(120) },
      run: async a => {
        writable();
        return JSON.stringify(await execOnLocalMachine(directory, String(a["command"]), Number(a["timeoutSeconds"] ?? 120)));
      },
    },
    {
      name: "machine_close",
      description: "Stop this chat's machine now instead of waiting for it to go idle. Files in /work stay in the thread directory.",
      schema: {},
      run: async () => { await closeLocalMachine(directory); return "Machine stopped."; },
    },
    {
      name: "job_submit",
      description: "Run a command in an environment on a machine as a durable job, and return its job ID immediately. Input paths are snapshotted from the thread directory into the job's /work; the command runs with bash -lc in a fresh container with no network. Results are whatever the command writes under beam/out: use beam_out in Python (from beam_out import out; out.quantity/check/series/table/field; out.write()) so the chat shows numbers with units, checks, plots and 3D. Files the manifest names are published; files over 20 MB stay on the machine and are listed. Use $BEAM_CORES for the MPI process count. Reuse requestKey when retrying. Do not assume success: read job state with get_job and results with results_read. In non-auto modes the requester approves first; unavailable in plan mode. Machine: only local today.",
      schema: {
        requestKey: z.string().min(1).max(160), title: z.string().min(1).max(120), environment: z.string(),
        command: z.string().min(1).max(8000), inputPaths: z.array(JobPath).max(64),
        machine: MachineId.default("local"), timeoutSeconds: z.number().int().min(1).max(86400),
      },
      run: async a => {
        writable();
        const env = resolveEnvironment(String(a["environment"]));
        const paths = z.array(JobPath).max(64).parse(a["inputPaths"]);
        const spec = EnvironmentJobSpec.parse({ version: 1, kind: "environment", title: a["title"], environment: { name: EnvironmentName.safeParse(env.name).success ? env.name : "custom", image: env.image }, command: a["command"], inputs: paths.map(path => ({ path, assetId: "staging" })), machine: a["machine"] ?? "local", timeoutSeconds: a["timeoutSeconds"] });
        const requestKey = z.string().min(1).max(160).parse(a["requestKey"]);
        const prior = await client.query(api.compute.findRequest, { token, runId, requestKey });
        if (prior) {
          const canonical = (s: { inputs: { path: string }[] }) => JSON.stringify({ ...s, inputs: s.inputs.map(i => i.path) });
          if (canonical(prior.spec as EnvironmentJobSpec) !== canonical(spec)) throw new Error("Request key belongs to a different job");
          return JSON.stringify({ id: prior._id, state: prior.state, reused: true });
        }
        const id = await client.mutation(api.compute.submitForRun, { token, runId, requestKey, spec: { ...spec, inputs: await stageInputs(client, token, runId, directory, paths) } });
        return JSON.stringify({ id, submitted: true, note: "Use get_job for state and logs, results_read once it succeeds. Approval may be required in Jobs." });
      },
    },
    {
      name: "results_read",
      description: "Read an environment job's results: its numbers (with units, references and uncertainty), checks, plots, tables, 3D fields, views and provenance, the published files with download URLs, and any files kept on the machine. Pass path (e.g. beam/out/series/x.json) to read one published JSON file's contents. Checks marked review or fail must be reported to the user with the result.",
      schema: { jobId: z.string(), path: JobPath.optional() },
      run: async a => {
        const job = await client.query(api.compute.forRun, { token, runId, id: String(a["jobId"]) as Id<"computeJobs"> });
        if (Array.isArray(job) || job.spec.kind !== "environment") throw new Error("Choose an environment job");
        if (job.state !== "succeeded") return JSON.stringify({ state: job.state, error: job.error, note: "Results appear when the job succeeds." });
        if (a["path"]) {
          const file = job.outputs.find(o => o.path === a["path"]);
          if (!file?.url) throw new Error(`No published file ${String(a["path"])}`);
          if (!file.path.endsWith(".json") || file.size > 256 * 1024) throw new Error("Only JSON files up to 256 KB can be read here; use the URL for others");
          const response = await fetch(file.url, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`Could not read ${file.path}`);
          return await response.text();
        }
        const manifest = job.results?.manifest ? ResultsManifest.parse(job.results.manifest) : null;
        return JSON.stringify({
          state: job.state,
          ...(manifest ? { headline: headlineQuantities(manifest), checkCounts: checkCounts(manifest), results: manifest } : { results: null, note: "The job wrote no beam/out/manifest.json." }),
          files: job.outputs.map(o => ({ path: o.path, bytes: o.size, url: o.url })),
          keptOnMachine: job.results?.unpublished ?? [],
        });
      },
    },
  ];
}
