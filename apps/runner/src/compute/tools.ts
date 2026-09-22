import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { BeamTool } from "@beam/harness";
import { JobPath, ProcessJobSpec } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { readJobFile } from "./local.ts";
import { uploadBytes } from "./watch.ts";

export function computeTools(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, permissionMode: string): BeamTool[] {
  return [
    { name: "list_jobs", description: "List durable compute jobs in this chat. Jobs continue independently of agent turns; inspect an existing job before submitting another.", schema: {}, run: async () => JSON.stringify(await client.query(api.compute.forRun, { token, runId })) },
    { name: "get_job", description: "Read a compute job's state, bounded log tail, input manifest and published result download URLs. Submission is not completion.", schema: { id: z.string() }, run: async a => JSON.stringify(await client.query(api.compute.forRun, { token, runId, id: String(a["id"]) as Id<"computeJobs"> })) },
    { name: "cancel_job", description: "Request cancellation of your compute job in this chat. Auto mode only; otherwise the requester uses the Jobs pane.", schema: { id: z.string() }, run: async a => { await client.mutation(api.compute.cancelForRun, { token, runId, id: String(a["id"]) as Id<"computeJobs"> }); return "Cancellation requested. Inspect the job for acknowledgement."; } },
    {
      name: "submit_job",
      description: "Submit a local background computation and return immediately with its durable job ID. Input paths are snapshotted from the thread directory into a separate job directory. Only explicit output paths are published. No shell is inserted; use an installed executable and argument list. Reuse requestKey when retrying the same logical submission. Do not assume success until get_job reports succeeded. In non-auto modes the requester approves in Jobs; unavailable in plan mode. Limits: 64 inputs, 20 MB/file, 100 MB total input, 16 outputs, 24 hours.",
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
        const id = await client.mutation(api.compute.submitForRun, { token, runId, requestKey, spec: { ...base, inputs } });
        return JSON.stringify({ id, submitted: true, note: "Use get_job for status and results. Approval may be required in Jobs." });
      },
    },
  ];
}
