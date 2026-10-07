import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { BeamTool } from "@beam/harness";
import { JobPath, ProcessJobSpec } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { readJobFile } from "./local.ts";
import { uploadBytes } from "./watch.ts";
/** Snapshot files from the thread directory into this chat's compute storage, for a job's input manifest. */
export async function stageInputs(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, paths: string[]) {
  const inputs: { path: string; assetId: string }[] = [];
  let total = 0;
  for (const path of paths) {
    const bytes = await readJobFile(directory, path); total += bytes.byteLength;
    if (total > 100 * 1024 * 1024) throw new Error("Inputs exceed 100 MB");
    const url = await client.mutation(api.compute.inputUploadUrl, { token, runId });
    const storageId = await uploadBytes(url, bytes);
    const assetId = await client.mutation(api.compute.stageInput, { token, runId, storageId, path });
    inputs.push({ path, assetId });
  }
  return inputs;
}
/** Lets an agent ask to be mentioned when a job (or a sweep's jobs) ends, instead of anyone having to come back (convex/jobResume.ts). */
export const continueWith = z.string().min(1).max(500).optional().describe("Optional: what you will do once this job ends (for a sweep, once all its jobs end), e.g. \"compare the three meshes and report the grid convergence index\". Beam then @mentions you with each job's outcome, as the person who approved the jobs, so the work continues without anyone coming back to ask. Approving the job approves this too. Use it for any job you'd otherwise wait or poll for.");
/** What to tell an agent after it submits: don't hold the turn open for a job, whether or not Beam will mention it later. */
export function afterSubmit(permissionMode: string, continuing: boolean, then: string) {
  if (permissionMode === "auto") return continuing ? "Beam will @mention you when it ends. Do not wait or poll: end your turn now, saying what is running and what you'll do with its results." : then;
  return "Each job waits for the person who asked to approve it (the simulation's Jobs tab, or Approve all). Do not wait or poll for that: end your turn now, saying which jobs need approving and what you found so far. "
    + (continuing ? "Approving them also approves continuing: Beam will @mention you once they've all ended." : "They will @mention you once the jobs have run.");
}
export function computeTools(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, permissionMode: string): BeamTool[] {
  return [
    { name: "list_simulations", description: "Read this chat's simulations, each with its versions (files, parameters, environment, command, what changed) and jobs with their results in brief, and activeId, the chat's working simulation. Save a next version with save_version and run it with run_version. A draft (draft: true, version 0) is work Beam saw on the machine before anything was saved; save_version without an id turns it into v1. A simulation of kind recipe is a study from the retired Simulation pane: read its results, but it cannot be edited or run; rebuild it as files to continue.", schema: {}, run: async () => JSON.stringify(await client.query(api.simulations.forRun, { token, runId })) },
    { name: "list_jobs", description: "List durable compute jobs in this chat, each with the simulation it belongs to. Jobs continue independently of agent turns; inspect an existing job before submitting another.", schema: {}, run: async () => JSON.stringify(await client.query(api.compute.forRun, { token, runId })) },
    { name: "get_job", description: "Read a compute job's state, bounded log tail, input manifest and published result download URLs. Submission is not completion.", schema: { id: z.string() }, run: async a => JSON.stringify(await client.query(api.compute.forRun, { token, runId, id: String(a["id"]) as Id<"computeJobs"> })) },
    { name: "cancel_job", description: "Request cancellation of your compute job in this chat. Auto mode only; otherwise the requester cancels it on the simulation's Jobs tab.", schema: { id: z.string() }, run: async a => { await client.mutation(api.compute.cancelForRun, { token, runId, id: String(a["id"]) as Id<"computeJobs"> }); return "Cancellation requested. Inspect the job for acknowledgement."; } },
    {
      name: "submit_job",
      description: "Submit a local background computation that runs an executable installed on this computer, and return immediately with its durable job ID. For engineering or physics tools, prefer job_submit, which runs in a pinned environment and publishes structured results. Input paths are snapshotted from the thread directory into a separate job directory. Only explicit output paths are published. No shell is inserted; use an installed executable and argument list. Reuse requestKey when retrying the same logical submission. Do not assume success until get_job reports succeeded. It belongs to the simulation you are working on (a draft if there is none yet). In non-auto modes the requester approves it on the simulation's Jobs tab; unavailable in plan mode. Limits: 64 inputs, 20 MB/file, 100 MB total input, 16 outputs, 24 hours.",
      schema: { requestKey: z.string().min(1).max(160), title: z.string(), executable: z.string(), args: z.array(z.string()), inputPaths: z.array(JobPath).max(64), outputs: z.array(JobPath).max(16), timeoutSeconds: z.number().int().min(1).max(86400) },
      run: async a => {
        if (permissionMode === "plan") throw new Error("Plan mode cannot submit compute jobs");
        const paths = z.array(JobPath).max(64).parse(a["inputPaths"]);
        const base = ProcessJobSpec.parse({ version: 1, kind: "process", title: a["title"], executable: a["executable"], args: a["args"], inputs: paths.map(path => ({ path, assetId: "staging" })), outputs: a["outputs"], timeoutSeconds: a["timeoutSeconds"] });
        const requestKey = z.string().min(1).max(160).parse(a["requestKey"]);
        const prior = await client.query(api.compute.findRequest, { token, runId, requestKey });
        if (prior) {
          const canonical = (spec: typeof base) => JSON.stringify({ ...spec, inputs: spec.inputs.map(i => i.path) });
          if (canonical(ProcessJobSpec.parse(prior.spec)) !== canonical(base)) throw new Error("Request key belongs to a different job");
          return JSON.stringify({ id: prior._id, state: prior.state, reused: true });
        }
        const inputs = await stageInputs(client, token, runId, directory, paths);
        const id = await client.mutation(api.compute.submitForRun, { token, runId, requestKey, spec: { ...base, inputs } });
        return JSON.stringify({ id, submitted: true, note: "Use get_job for status and results. Outside auto mode the requester approves it first, on the simulation's Jobs tab or card." });
      },
    },
  ];
}
