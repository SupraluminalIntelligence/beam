import { z } from "zod";
import type { ConvexClient } from "convex/browser";
import type { BeamTool } from "@beam/harness";
import { JobPath, ProcessJobSpec, SimulationCase, PlanarCase, WakeFields, decodeWakeFrames, decodeWakeGeometry, SimulationReport } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { readJobFile } from "./local.ts";
import { planarMesh } from "./planar.ts";
import { comparePlanarFields } from "./compare.ts";
import { uploadBytes } from "./watch.ts";

export function computeTools(client: ConvexClient, token: string, runId: Id<"runs">, directory: string, permissionMode: string): BeamTool[] {
  return [
    {name:"validate_simulation",description:"Preflight a proposed study before saving. Validates geometry loops, body placement, boundary coverage and settings. For planar geometry, generates a candidate constrained mesh and returns its cell count. This does NOT run OpenFOAM checkMesh or validate the physics. Correct errors, then save_simulation and run_simulation mesh. Read-only; no job is launched.",schema:{config:SimulationCase},run:async a=>{const c=SimulationCase.parse(a["config"]);return JSON.stringify(c.geometry==="planar"?{valid:true,region:c.region,bodies:c.bodies.map(b=>({name:b.name,shape:b.shape,boundary:b.boundary})),boundaries:c.boundaries,refinements:c.refinements??[],motion:c.motion??null,candidateCells:planarMesh(PlanarCase.parse(c)).cells,solver:"pimpleFoam",physics:"2D incompressible laminar isothermal",next:"Save, then run mesh to obtain checkMesh quality diagnostics."}:{valid:true,geometry:c.geometry});}},
    {name:"select_simulation",description:"Choose an existing study in this chat as the explicit working target for this agent turn and future messages. Use when the user names another study. Read list_simulations first. Does not modify its setup or run it.",schema:{caseId:z.string()},run:async a=>JSON.stringify(await client.mutation(api.compute.selectSimulationForRun,{token,runId,caseId:String(a["caseId"]) as Id<"simulationCases">}))},
    { name: "list_simulations", description: "Read simulation studies, the active study ID, saved setups and job history, plus runtime availability. Read before each edit; follow-ups normally update the active study instead of creating another. Supports agent-composed planar flow: an arbitrary simple polygon fluid domain minus independently placed circles/polygons, named inlet/outlet/wall/symmetry boundaries, fluid viscosity and density, and a transient laminar solver. Also retains heated-channel and cylinder examples. No 3D CAD or coupled solid regions.", schema: {}, run: async()=>JSON.stringify(await client.query(api.compute.simulationForRun,{token,runId})) },
    { name: "save_simulation", description: "Create or update a simulation study shared by chat and the Simulation pane. Creating a study opens a live study card and selects it. Changes to an existing study create a revision and preserve earlier runs. Use the existing id for follow-ups; omit id only for a genuinely new study. Read list_simulations first; pass id and current revision to update without overwriting concurrent edits. Use geometry=planar to construct new geometries rather than force a request into an example. Domain edgeBoundaries[i] labels the edge from vertex i to the next (closing automatically). Bodies are excluded from the fluid, each with a named wall. Define exactly the referenced boundaries, fluid region properties, meshSize, initialVelocity, duration and frames. Optional refinements are named body-distance bands (body, distance, size, transition) or axis-aligned boxes (min, max, size, transition). Keep meshSize as the coarse background. Smallest overlapping size wins; transition must be >= 2*(meshSize-size). Budget is 12000 cells; preflight and reduce refinement extent or relax target sizes if exceeded. Refine wakes with boxes and body surfaces with body-distance bands. Refinement changes require a new mesh. All values are SI; planar duration is seconds, legacy cylinder duration is D/U. Never infer viscosity from a material label; set explicit properties and disclose assumptions. Optional motion prescribes one pitching body: {kind:pitch,body,pivot:[x,y],meanAngleDegrees,amplitudeDegrees,frequencyHz}. Rotation is mean + amplitude*sin(2*pi*frequency*time), relative to the supplied geometry; do not double-apply an existing angle of attack. Amplitude is positive and <=20 degrees. Require >=16 saved frames per cycle (max100 total), an exclusive wall patch and clear full rotation envelope plus one background cell. A deforming mesh and moving-wall velocity are solved; no free-body dynamics, continuous rotation, translation or multiple moving bodies. Motion changes require remeshing; check every saved moving mesh after solving. Call validate_simulation before saving new geometry. Does not mesh or run. Unavailable in plan mode.", schema: {id:z.string().optional(),revision:z.number().int().positive().optional(),name:z.string().min(1).max(100),config:SimulationCase}, run:async a=>{
      const id=a["id"] as Id<"simulationCases">|undefined,revision=a["revision"] as number|undefined;
      return JSON.stringify(await client.mutation(api.compute.saveSimulationForRun,{token,runId,name:String(a["name"]),config:SimulationCase.parse(a["config"]),...(id?{id}:{}),...(revision!==undefined?{revision}:{})}));
    } },
    { name: "run_simulation", description: "Submit mesh or solve for an existing saved case revision. Meshing builds the declared geometry (constrained triangulation for planar flow, blockMesh for examples) and runs checkMesh. Solving requires a succeeded matching mesh job ID; it returns a durable job ID, not a completed calculation. Use list_jobs/get_job to inspect logs and real result URLs. Reuse requestKey on retries. Non-auto runs require requester approval. Planar circles and polygons are supported; imported 3D CAD, turbulence and conjugate heat transfer are not.", schema:{caseId:z.string(),revision:z.number().int().positive(),stage:z.enum(["mesh","solve"]),meshJobId:z.string().optional(),requestKey:z.string().min(1).max(160)},run:async a=>{
      const meshJobId=a["meshJobId"] as Id<"computeJobs">|undefined;
      const id=await client.mutation(api.compute.submitSimulationForRun,{token,runId,caseId:String(a["caseId"]) as Id<"simulationCases">,revision:Number(a["revision"]),stage:z.enum(["mesh","solve"]).parse(a["stage"]),requestKey:String(a["requestKey"]),...(meshJobId?{meshJobId}:{})});return JSON.stringify({id,submitted:true,note:"Inspect get_job for completion; results are not validated engineering answers."});
    } },
    {name:"compare_simulation_runs",description:"Compare two succeeded planar solve jobs from the same study at their latest common physical time. Returns mesh quality, saved refinement settings and area-weighted speed, pressure and kinetic-energy statistics. Requires unchanged geometry and physics. Does not compute forces, shedding frequency or establish mesh convergence. Read-only; use after a refinement rerun and report the limitations.",schema:{baselineJobId:z.string(),candidateJobId:z.string()},run:async args=>{
      const load=async(id:string)=>{
        const job=await client.query(api.compute.forRun,{token,runId,id:id as Id<"computeJobs">});
        if(Array.isArray(job)||job.state!=="succeeded"||job.spec.simulation?.stage!=="solve"||job.spec.simulation.config.geometry!=="planar")throw new Error("Choose a succeeded planar solve job");
        const read=async(path:string)=>{const asset=job.outputs.find(o=>o.path===path);if(!asset?.url||asset.size>20*1024*1024)throw new Error(`Missing or oversized ${path}`);const response=await fetch(asset.url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Cannot read ${path}`);const bytes=await response.arrayBuffer();if(bytes.byteLength!==asset.size)throw new Error(`Incomplete ${path}`);return bytes;};
        const [manifest,binary,reportBytes]=await Promise.all([read("fields.json"),read("frames.bin"),read("report.json")]);
        const fields=WakeFields.parse(JSON.parse(new TextDecoder().decode(manifest))),report=SimulationReport.parse(JSON.parse(new TextDecoder().decode(reportBytes)));
        return{jobId:id,caseId:job.spec.simulation.caseId,revision:job.spec.simulation.revision,config:PlanarCase.parse(job.spec.simulation.config),fields,frames:decodeWakeFrames(binary,fields),...(fields.motion?{geometry:decodeWakeGeometry(await read("geometry.bin"),fields)}:{}),mesh:{cells:report.cells,checkMesh:report.meshOk,maxNonOrthogonality:report.maxNonOrthogonality,maxSkewness:report.maxSkewness,maxCourant:report.maxCourant}};
      };
      if(args["baselineJobId"]===args["candidateJobId"])throw new Error("Choose two different runs");
      const [a,b]=await Promise.all([load(String(args["baselineJobId"])),load(String(args["candidateJobId"]))]);
      if(a.caseId!==b.caseId)throw new Error("Choose runs from the same study");
      const summary=(r:typeof a)=>({jobId:r.jobId,revision:r.revision,backgroundSize:r.config.meshSize,refinements:r.config.refinements??[],mesh:r.mesh});
      return JSON.stringify({baseline:summary(a),candidate:summary(b),comparison:comparePlanarFields(a,b)});
    }},
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
