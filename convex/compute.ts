import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChat, readableAction, readableMutation, readableQuery } from "./lib";
import { runnerForToken } from "./runners";
import { ownRun } from "./runs";
import { isGatewayToken } from "./gateway";
import { metered, reserve, settle } from "./computeBudget";
import { JobPath, JobSpec, ProcessJobSpec, jobFinished, jobStudy, MAX_COMPUTE_FILE_BYTES, MAX_COMPUTE_INPUT_BYTES } from "../packages/contracts/src/compute";
import { FieldPreview, MAX_RESULT_FILES, previewByteLengths, previewLengthMismatch, resultPaths, ResultsManifest, RESULTS_ROOT } from "../packages/contracts/src/results";
import { LARGE_OUTPUT_PART_BYTES, MAX_JOB_LARGE_OUTPUT_BYTES, MAX_LARGE_OUTPUT_BYTES, PartNumbers, Sha256Hex, UploadId, largeOutputKey, largeOutputReasons, planParts, type LargeOutputStart, type LargeOutputUrls } from "../packages/contracts/src/largeOutputs";
import { objectStore, signObject } from "./objectStore";
import { CLOUD_LAUNCH_WINDOW_SECONDS, CLOUD_MAX_TIMEOUT_SECONDS, MACHINES, authorizedCents, cloudCentsPerHour, formatCents } from "../packages/contracts/src/machines";
import { SimulationCase, meshKey, simulationOutputs, meshAssetPath, meshInputPath, simulationMeshInputs, modelInputPath, MODEL_MAX_TRIANGLES, studyOutput } from "../packages/contracts/src/simulation";
import { isCfdImage } from "../packages/contracts/src/environments";

type Ctx = QueryCtx | MutationCtx;
const executing = ["preparing", "running", "publishing"];
export const summary = ({ spec, log, results, ...job }: Doc<"computeJobs">) => { const s = JobSpec.parse(spec); return { ...job, title: s.title, simulation: jobStudy(s) ?? null, environment: s.kind === "environment" ? s.environment.name : null, simulationVersion: s.kind === "environment" ? s.simulation ?? null : null }; };
/** Studies were the first simulations. Installed apps and runners understand only recipe simulations, so the study functions return only those. */
export const isRecipe = (s: Doc<"simulationCases">) => (s.kind ?? "recipe") === "recipe";

export async function chatAccess(ctx: Ctx, chatId: Id<"chats">, login: string) {
  const chat = await ctx.db.get(chatId);
  const members = chat && await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  if (!chat || chat.state === "deleted" || !members?.some(m => m.githubLogin === login) || (chat.private && !chat.members.includes(login))) throw new Error("Chat access revoked");
  return chat;
}
export async function runAccess(ctx: Ctx, token: string, runId: Id<"runs">) {
  const result = await ownRun(ctx, token, runId);
  await chatAccess(ctx, result.run.chatId, result.run.dispatchedBy);
  return result;
}
/** Local jobs belong to the runner they target; cloud jobs to the gateway. */
async function workerAccess(ctx: Ctx, token: string, jobId: Id<"computeJobs">) {
  const job = await ctx.db.get(jobId);
  if (job && job.backend !== "local-process") {
    if (!(await isGatewayToken(token))) throw new Error("Not this runner's job");
    return { job, runner: null };
  }
  const runner = await runnerForToken(ctx, token);
  if (!job || job.runnerId !== runner._id) throw new Error("Not this runner's job");
  return { job, runner };
}
/** A cloud job's rate and authorized amount, or null for a job on the engineer's computer. */
function cloudBilling(spec: JobSpec) {
  if (spec.kind !== "environment" || spec.machine === "local") return null;
  const machine = MACHINES[spec.machine], centsPerHour = cloudCentsPerHour(machine);
  if (centsPerHour === null) throw new Error(`The ${machine.label} is not available yet. Cloud jobs can use: ${Object.values(MACHINES).filter(m => cloudCentsPerHour(m) !== null).map(m => m.id).join(", ")}.`);
  if (spec.timeoutSeconds > CLOUD_MAX_TIMEOUT_SECONDS) throw new Error(`Cloud jobs can run for at most ${Math.floor(CLOUD_MAX_TIMEOUT_SECONDS / 360) / 10} hours (timeoutSeconds ${CLOUD_MAX_TIMEOUT_SECONDS})`);
  return { centsPerHour, authorizedCents: authorizedCents(centsPerHour, spec.timeoutSeconds), spentCents: 0, reserved: false };
}
async function targetAccess(ctx: Ctx, chatId: Id<"chats">, runnerId: Id<"runners">, login: string) {
  const chat = await chatAccess(ctx, chatId, login);
  const runner = await ctx.db.get(runnerId);
  if (!runner || runner.computeBackend !== "local-process" || !runner.online || runner.lastSeen < Date.now() - 90_000) throw new Error("Compute runner is offline or needs an update");
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  if (!members.some(m => m.githubLogin === runner.ownerLogin) || (runner.ownerLogin !== login && !runner.allowSharedRuns)) throw new Error("Runner is not shared with you");
  return runner;
}

export async function enqueue(ctx: MutationCtx, input: { chatId: Id<"chats">; runnerId: Id<"runners">; requestedBy: string; sourceRunId?: Id<"runs">; requestKey: string; spec: unknown; needsApproval: boolean }) {
  const spec = JobSpec.parse(input.spec);
  const billing = cloudBilling(spec);
  if (!input.requestKey.trim() || input.requestKey.length > 160) throw new Error("Invalid request key");
  const chat = await chatAccess(ctx, input.chatId, input.requestedBy);
  const existing = await ctx.db.query("computeJobs").withIndex("by_request", q => q.eq("chatId", input.chatId).eq("requestedBy", input.requestedBy).eq("requestKey", input.requestKey)).first();
  if (existing) {
    if (existing.runnerId !== input.runnerId || JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new Error("Request key already used for a different job");
    return existing._id;
  }
  // A cloud job runs on the gateway; the runner it came from only has to be the requester's to name.
  const target = billing ? null : await targetAccess(ctx, input.chatId, input.runnerId, input.requestedBy);
  const study=jobStudy(spec);
  if(target&&study){
    if(!target.openfoam?.ready) throw new Error(target.openfoam?.message ?? "Update this runner to enable OpenFOAM");
    if(target.openfoam.image!==(spec.kind==="environment"?spec.environment.image:study.image))throw new Error("Runner has a different OpenFOAM runtime; update and re-probe it");
    const sim=study, model=await ctx.db.get(sim.caseId as Id<"simulationCases">);
    if(!model || model.chatId!==input.chatId || model.revision!==sim.revision || JSON.stringify(SimulationCase.parse(model.config))!==JSON.stringify(sim.config)) throw new Error("Simulation revision changed; reload the case");
    if(sim.stage==="solve"){
      const mesh=await ctx.db.get(sim.meshJobId as Id<"computeJobs">), prior=mesh && jobStudy(JobSpec.parse(mesh.spec));
      if(!mesh || mesh.chatId!==input.chatId || mesh.state!=="succeeded" || prior?.stage!=="mesh" || prior.caseId!==sim.caseId || meshKey(prior.config)!==meshKey(sim.config)) throw new Error("Build a matching mesh before solving");
      const asset=await ctx.db.get(spec.inputs[0]!.assetId as Id<"computeAssets">);
      if(!asset || !mesh.outputs.includes(asset._id) || !studyOutput([asset],meshAssetPath(sim.config))) throw new Error("Use the mesh output of the selected mesh job");
    }
    // An imported body meshes from exactly the stored surface its study names.
    if(sim.stage==="mesh"&&sim.config.geometry==="domain3d")for(const b of sim.config.bodies){
      if(b.shape!=="model")continue;
      const input=spec.inputs.find(i=>i.path===modelInputPath(b)),asset=input&&input.assetId===b.model.assetId?await ctx.db.get(input.assetId as Id<"computeAssets">):null;
      if(!asset||asset.sha256!==b.model.sha256)throw new Error(`Model ${b.model.file} for body ${b.name} is unavailable in this chat; import it again`);
    }
  }
  let size = 0;
  for (const reference of spec.inputs) {
    const asset = await ctx.db.get(reference.assetId as Id<"computeAssets">);
    if (!asset || asset.chatId !== input.chatId) throw new Error("Input asset is not in this chat");
    size += asset.size;
  }
  if (size > MAX_COMPUTE_INPUT_BYTES) throw new Error("Local jobs support up to 100 MB of input");
  const now = Date.now();
  const reserved = billing && !input.needsApproval ? await reserve(ctx, chat.workspaceId, billing) : billing;
  const id = await ctx.db.insert("computeJobs", {
    chatId: input.chatId, runnerId: input.runnerId, requestedBy: input.requestedBy,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), requestKey: input.requestKey,
    backend: billing ? "modal-sandbox" : "local-process", spec, state: input.needsApproval ? "awaiting-approval" : "queued",
    createdAt: now, updatedAt: now, log: "", error: null, outputs: [], ...(reserved ? { billing: reserved } : {}),
  });
  if(study) await ensureStudyCard(ctx,study.caseId as Id<"simulationCases">,input.requestedBy);
  else if(spec.kind==="environment"&&spec.simulation) { /* The simulation's card shows its jobs. */ }
  else await ctx.db.insert("messages", { chatId: input.chatId, author: input.requestedBy, kind: "text", text: `Compute job: ${spec.title}`, runId: input.sourceRunId ?? null, computeJobId: id, reactions: [] });
  await ctx.db.patch(input.chatId, { lastMessageAt: now });
  return id;
}

export const submit = mutation({ args: { chatId: v.id("chats"), runnerId: v.id("runners"), requestKey: v.string(), spec: v.any() }, handler: async (ctx, a) => {
  const { u } = await requireChat(ctx, a.chatId);
  return enqueue(ctx, { ...a, requestedBy: u.githubLogin!, needsApproval: false });
} });
export const simulationCases = query({args:{chatId:v.id("chats")},handler:async(ctx,{chatId})=>{
  await requireChat(ctx,chatId);return (await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect()).filter(isRecipe);
}});
/** One durable chat card per study. Existing cases acquire a card when first opened. */
async function ensureStudyCard(ctx:MutationCtx,id:Id<"simulationCases">,login:string,sourceRunId?:Id<"runs">){
  const study=await ctx.db.get(id);if(!study||study.cardMessageId)return;
  const run=sourceRunId?await ctx.db.get(sourceRunId):null;
  const cardMessageId=await ctx.db.insert("messages",{chatId:study.chatId,author:run?`agent:${run.agentId}`:login,kind:"text",text:`Simulation study: ${study.name}`,runId:sourceRunId??null,simulationStudyId:id,reactions:[]});
  await ctx.db.patch(id,{cardMessageId});await ctx.db.patch(study.chatId,{lastMessageAt:Date.now()});
}
async function rememberRevision(ctx:MutationCtx,study:Doc<"simulationCases">){
  const prior=await ctx.db.query("simulationRevisions").withIndex("by_study_revision",q=>q.eq("studyId",study._id).eq("revision",study.revision)).first();
  if(!prior)await ctx.db.insert("simulationRevisions",{studyId:study._id,revision:study.revision,name:study.name,config:study.config,createdAt:study.updatedAt,createdBy:study.updatedBy});
}
const saveCaseArgs = {id:v.optional(v.id("simulationCases")),revision:v.optional(v.number()),name:v.string(),config:v.any()};
async function saveCase(ctx:MutationCtx,chatId:Id<"chats">,login:string,a:{id?:Id<"simulationCases">|undefined;revision?:number|undefined;name:string;config:unknown},sourceRunId?:Id<"runs">) {
  const config=SimulationCase.parse(a.config),name=a.name.trim();
  if(!name||name.length>100)throw new Error("Use a study name of 1–100 characters");
  if(a.id){
    const prior=await ctx.db.get(a.id);
    if(!prior||prior.chatId!==chatId||!isRecipe(prior))throw new Error("Study unavailable");
    if(prior.revision!==a.revision)throw new Error("Another edit changed this study. Reload before saving.");
    await ensureStudyCard(ctx,a.id,login,sourceRunId);await rememberRevision(ctx,prior);
    if(prior.name===name&&JSON.stringify(SimulationCase.parse(prior.config))===JSON.stringify(config))return{id:a.id,revision:prior.revision};
    const revision=prior.revision+1,updatedAt=Date.now();
    await ctx.db.patch(a.id,{name,config,revision,updatedBy:login,updatedAt});
    await rememberRevision(ctx,{...prior,name,config,revision,updatedAt,updatedBy:login});return{id:a.id,revision};
  }
  const chat=await ctx.db.get(chatId);
  const id=await ctx.db.insert("simulationCases",{chatId,name,config,revision:1,updatedBy:login,updatedAt:Date.now(),kind:"recipe",...(chat?{workspaceId:chat.workspaceId}:{})});
  await rememberRevision(ctx,(await ctx.db.get(id))!);await ensureStudyCard(ctx,id,login,sourceRunId);
  await ctx.db.patch(chatId,{activeStudyId:id});if(sourceRunId)await ctx.db.patch(sourceRunId,{studyId:id});
  return{id,revision:1};
}
async function selectStudy(ctx:MutationCtx,chatId:Id<"chats">,id:Id<"simulationCases">|null,login:string,sourceRunId?:Id<"runs">){
  const chat=await chatAccess(ctx,chatId,login);
  if(id){const study=await ctx.db.get(id);if(!study||study.chatId!==chatId)throw new Error("Study unavailable in this chat");}
  if(!sourceRunId&&chat.activeStudyId!==id){
    const runs=await ctx.db.query("runs").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect();
    if(runs.some(r=>["queued","starting","working","landing"].includes(r.state)))throw new Error("The agent is working on this chat. Finish or stop its turn before changing the working study.");
  }
  await ctx.db.patch(chatId,{activeStudyId:id});
  if(sourceRunId)await ctx.db.patch(sourceRunId,{studyId:id});
  if(id)await ensureStudyCard(ctx,id,login,sourceRunId);
}
export const selectSimulation=mutation({args:{chatId:v.id("chats"),caseId:v.union(v.id("simulationCases"),v.null())},handler:async(ctx,a)=>{const {u}=await requireChat(ctx,a.chatId);await selectStudy(ctx,a.chatId,a.caseId,u.githubLogin!);}});
export const studyContext=query({args:{chatId:v.id("chats")},handler:async(ctx,a)=>{const {chat}=await requireChat(ctx,a.chatId);return{activeStudyId:chat.activeStudyId??null,studies:(await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect()).filter(isRecipe)};}});
export const workspaceStudies=query({args:{chatId:v.id("chats")},handler:async(ctx,a)=>{
 const {chat,u}=await requireChat(ctx,a.chatId);
 const chats=await ctx.db.query("chats").withIndex("by_workspace",q=>q.eq("workspaceId",chat.workspaceId)).collect();
 const accessible=chats.filter(c=>c.state!=="deleted"&&(!c.private||c.members.includes(u.githubLogin!)));
 return(await Promise.all(accessible.map(async c=>(await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",c._id)).collect()).filter(isRecipe).map(s=>({id:s._id,name:s.name,revision:s.revision,chatId:c._id,chatTitle:c.title,workspaceId:c.workspaceId}))))).flat();
}});
export const study=query({args:{id:v.id("simulationCases")},handler:async(ctx,a)=>{
 const study=await ctx.db.get(a.id);if(!study||!isRecipe(study))return null;await requireChat(ctx,study.chatId);
 const jobs=(await ctx.db.query("computeJobs").withIndex("by_chat",q=>q.eq("chatId",study.chatId)).order("desc").collect()).map(summary).filter(j=>j.simulation?.caseId===a.id);
 const revisions=await ctx.db.query("simulationRevisions").withIndex("by_study_revision",q=>q.eq("studyId",a.id)).collect();
 return{...study,jobs,revisions:revisions.map(({revision,name,createdAt,createdBy})=>({revision,name,createdAt,createdBy}))};
}});
const simulationArgs={caseId:v.id("simulationCases"),revision:v.number(),stage:v.union(v.literal("mesh"),v.literal("solve")),meshJobId:v.optional(v.id("computeJobs")),requestKey:v.string()};
type SubmitCase={caseId:Id<"simulationCases">;revision:number;stage:"mesh"|"solve";meshJobId?:Id<"computeJobs">|undefined;requestKey:string};
async function enqueueSimulation(ctx:MutationCtx,chatId:Id<"chats">,runnerId:Id<"runners">,login:string,a:SubmitCase,needsApproval:boolean,sourceRunId?:Id<"runs">){
  // A retry still resolves to its original immutable job after someone edits the case.
  const prior=await ctx.db.query("computeJobs").withIndex("by_request",q=>q.eq("chatId",chatId).eq("requestedBy",login).eq("requestKey",a.requestKey)).first();
  if(prior){const old=jobStudy(JobSpec.parse(prior.spec));if(prior.runnerId!==runnerId||old?.caseId!==a.caseId||old.revision!==a.revision||old.stage!==a.stage||old.meshJobId!==a.meshJobId)throw new Error("Request key already used for a different job");return prior._id;}
  const model=await ctx.db.get(a.caseId);
  if(!model||model.chatId!==chatId||model.revision!==a.revision)throw new Error("Simulation revision changed; reload the case");
  const inputs:{assetId:string;path:string}[]=a.stage==="mesh"?simulationMeshInputs(SimulationCase.parse(model.config)):[];
  const config=SimulationCase.parse(model.config);
  if(a.stage==="solve"&&a.meshJobId){const mesh=await ctx.db.get(a.meshJobId);if(mesh?.chatId!==chatId)throw new Error("Mesh unavailable");for(const id of mesh.outputs){const asset=await ctx.db.get(id);if(asset&&studyOutput([asset],meshAssetPath(config)))inputs.push({assetId:id,path:meshInputPath(config)});}}
  const study={caseId:a.caseId,revision:model.revision,stage:a.stage,config,...(a.meshJobId?{meshJobId:a.meshJobId}:{})};
  const title=`${model.name} · ${a.stage} · r${model.revision}`,timeoutSeconds=config.geometry==="domain3d"?4*3600:3600;
  // A runner with the cfd environment runs the study there, as an environment job with standard results;
  // an older runner still runs it on OpenFOAM's own image.
  const runtime=(await ctx.db.get(runnerId))?.openfoam?.image;
  const spec=runtime&&isCfdImage(runtime)
    ?{version:1,kind:"environment",title,environment:{name:"cfd",image:runtime},command:"beam-recipe",inputs,machine:"local",timeoutSeconds,recipe:study}
    :{version:1,kind:"process",title,executable:"beam:openfoam",args:[],inputs,outputs:simulationOutputs(a.stage,config),timeoutSeconds,simulation:study};
  return enqueue(ctx,{chatId,runnerId,requestedBy:login,requestKey:a.requestKey,needsApproval,...(sourceRunId?{sourceRunId}:{}),spec});
}
export const saveSimulation=mutation({args:{chatId:v.id("chats"),...saveCaseArgs},handler:async(ctx,a)=>{const{u}=await requireChat(ctx,a.chatId);if(!a.id){const runs=await ctx.db.query("runs").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect();if(runs.some(r=>["queued","starting","working","landing"].includes(r.state)))throw new Error("Ask the working agent to create the new study, or wait for its turn to finish.");}return saveCase(ctx,a.chatId,u.githubLogin!,a);}});
export const submitSimulation=mutation({args:{chatId:v.id("chats"),runnerId:v.id("runners"),...simulationArgs},handler:async(ctx,a)=>{const{u}=await requireChat(ctx,a.chatId);return enqueueSimulation(ctx,a.chatId,a.runnerId,u.githubLogin!,a,false);}});
export const simulationForRun=readableQuery({args:{token:v.string(),runId:v.id("runs"),messageId:v.optional(v.id("messages"))},handler:async(ctx,a)=>{
 const {run}=await runAccess(ctx,a.token,a.runId);const runner=await ctx.db.get(run.runnerId),chat=await ctx.db.get(run.chatId);
 const cases=(await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",run.chatId)).collect()).filter(isRecipe);
 const activeStudyId=run.studyId===undefined?chat?.activeStudyId??null:run.studyId;
 const jobs=(await ctx.db.query("computeJobs").withIndex("by_chat",q=>q.eq("chatId",run.chatId)).order("desc").collect()).map(summary).filter(j=>j.simulation);
 const dispatch=await ctx.db.get(a.messageId??run.dispatchMessageId);if(a.messageId&&dispatch?.chatId!==run.chatId)throw new Error("Message unavailable in this chat");
 return{activeStudyId,messageStudyContext:dispatch?.studyContext??null,cases,jobs,runtime:runner?.openfoam??null};
}});
async function simulationRunAccess(ctx:MutationCtx,token:string,runId:Id<"runs">){const{run}=await runAccess(ctx,token,runId);if(!["working","starting"].includes(run.state))throw new Error("Agent run has ended");const agent=await ctx.db.get(run.agentId);if(!agent||agent.permissionMode==="plan")throw new Error("Plan mode cannot edit or submit simulations");return{run,agent};}
export const saveSimulationForRun=readableMutation({args:{token:v.string(),runId:v.id("runs"),...saveCaseArgs},handler:async(ctx,a)=>{const{run}=await simulationRunAccess(ctx,a.token,a.runId);if(a.id&&a.id!==(run.studyId===undefined?(await ctx.db.get(run.chatId))?.activeStudyId:run.studyId))throw new Error("Select this study explicitly before editing it");return saveCase(ctx,run.chatId,run.dispatchedBy,a,run._id);}});
export const selectSimulationForRun=readableMutation({args:{token:v.string(),runId:v.id("runs"),caseId:v.id("simulationCases")},handler:async(ctx,a)=>{const {run}=await simulationRunAccess(ctx,a.token,a.runId);await selectStudy(ctx,run.chatId,a.caseId,run.dispatchedBy,run._id);return{activeStudyId:a.caseId};}});
export const submitSimulationForRun=readableMutation({args:{token:v.string(),runId:v.id("runs"),...simulationArgs},handler:async(ctx,a)=>{const{run,agent}=await simulationRunAccess(ctx,a.token,a.runId);if(a.caseId!==(run.studyId===undefined?(await ctx.db.get(run.chatId))?.activeStudyId:run.studyId))throw new Error("Select this study explicitly before running it");return enqueueSimulation(ctx,run.chatId,run.runnerId,run.dispatchedBy,a,agent.permissionMode!=="auto",run._id);}});
export const submitForRun = readableMutation({ args: { token: v.string(), runId: v.id("runs"), requestKey: v.string(), spec: v.any() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  if (!["working", "starting"].includes(run.state)) throw new Error("Agent run has ended");
  const agent = await ctx.db.get(run.agentId);
  if (!agent || agent.permissionMode === "plan") throw new Error("Plan mode cannot submit compute jobs");
  return enqueue(ctx, { chatId: run.chatId, runnerId: run.runnerId, requestedBy: run.dispatchedBy, sourceRunId: run._id, requestKey: a.requestKey, spec: a.spec, needsApproval: agent.permissionMode !== "auto" });
} });
export const approve = mutation({ args: { id: v.id("computeJobs") }, handler: async (ctx, { id }) => {
  const job = await ctx.db.get(id); if (!job) throw new Error("Job not found");
  const { u } = await requireChat(ctx, job.chatId);
  if (job.state !== "awaiting-approval") return;
  if (u.githubLogin !== job.requestedBy) throw new Error("Only the requester can approve this job");
  if (job.billing) {
    const chat = await chatAccess(ctx, job.chatId, job.requestedBy);
    await ctx.db.patch(id, { state: "queued", approvedBy: u.githubLogin!, updatedAt: Date.now(), billing: await reserve(ctx, chat.workspaceId, job.billing) });
    return;
  }
  await targetAccess(ctx, job.chatId, job.runnerId, job.requestedBy);
  await ctx.db.patch(id, { state: "queued", approvedBy: u.githubLogin!, updatedAt: Date.now() });
} });
async function cancelJob(ctx: MutationCtx, id: Id<"computeJobs">) {
  const job = await ctx.db.get(id); if (!job || jobFinished(job.state)) return;
  const now = Date.now(), unclaimed = ["queued", "awaiting-approval"].includes(job.state);
  const billing = unclaimed ? await settle(ctx, job, now) : job.billing;
  await ctx.db.patch(id, { cancelRequestedAt: now, updatedAt: now, ...(unclaimed ? { state: "cancelled", endedAt: now } : {}), ...(billing ? { billing } : {}) });
}
export const cancel = mutation({ args: { id: v.id("computeJobs") }, handler: async (ctx, { id }) => {
  const job = await ctx.db.get(id); if (!job) throw new Error("Job not found");
  await requireChat(ctx, job.chatId); await cancelJob(ctx, id);
} });
export const cancelForRun = readableMutation({ args: { token: v.string(), runId: v.id("runs"), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  const agent = await ctx.db.get(run.agentId);
  if (agent?.permissionMode !== "auto") throw new Error("Cancel this job using the Jobs panel");
  const job = await ctx.db.get(a.id);
  if (!job || job.chatId !== run.chatId || job.requestedBy !== run.dispatchedBy) throw new Error("Not your job in this chat");
  await cancelJob(ctx, a.id);
} });
export const list = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  await requireChat(ctx, chatId);
  return (await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", chatId)).order("desc").take(100)).map(summary);
} });
async function detail(ctx: Ctx, job: Doc<"computeJobs">) {
  const runner = await ctx.db.get(job.runnerId);
  const outputs = await Promise.all(job.outputs.map(async id => {
    const asset = await ctx.db.get(id);
    return asset ? { id: id as Id<"computeAssets"> | Id<"computeObjects">, path: asset.path, size: asset.size, sha256: asset.sha256, url: await ctx.storage.getUrl(asset.storageId), storage: "convex" as "convex" | "r2" } : null;
  }));
  // Outputs over the Convex limit live in the object store; a viewer asks outputUrl for a short-lived link.
  const large = (await largeObjects(ctx, job._id)).map(o => ({ id: o._id as Id<"computeAssets"> | Id<"computeObjects">, path: o.path, size: o.size, sha256: o.sha256, url: null, storage: "r2" as const }));
  const spec = JobSpec.parse(job.spec), published = [...outputs.filter(o => o !== null), ...large];
  // A cloud job runs on its machine, not on the runner it was submitted from.
  const cloud = spec.kind === "environment" && job.backend !== "local-process" ? MACHINES[spec.machine].label : null;
  return { ...job, spec, runnerName: cloud ?? runner?.name ?? "Runner", runnerOnline: cloud ? true : !!runner?.online && runner.lastSeen > Date.now() - 90_000, outputs: published, provenance: await provenance(ctx, job, spec, published) };
}
/**
 * Where an environment job's results came from, from Beam's own records rather than anything the job
 * wrote: the pinned image, command and machine from its immutable spec, input and output hashes Convex
 * computed on upload, when Beam claimed it and recorded its outcome, and its exit code. A replay starts from this.
 */
async function provenance(ctx: Ctx, job: Doc<"computeJobs">, spec: JobSpec, outputs: { path: string; sha256: string; size: number }[]) {
  if (spec.kind !== "environment" || !job.handle) return null;
  const inputs = await Promise.all(spec.inputs.map(async i => { const asset = await ctx.db.get(i.assetId as Id<"computeAssets">); return { path: i.path, sha256: asset?.sha256 ?? null, size: asset?.size ?? null }; }));
  return {
    environment: spec.environment, command: spec.command, machine: spec.machine, timeoutSeconds: spec.timeoutSeconds, backend: job.backend,
    inputs, outputs: outputs.map(({ path, sha256, size }) => ({ path, sha256, size })),
    // When Beam claimed the job and recorded its outcome: they bound the command's run, not time it.
    claimedAt: job.startedAt ?? null, recordedAt: job.endedAt ?? null, exitCode: job.exitCode ?? null, state: job.state,
  };
}
export const get = query({ args: { id: v.id("computeJobs") }, handler: async (ctx, { id }) => {
  const job = await ctx.db.get(id); if (!job) return null;
  await requireChat(ctx, job.chatId); return detail(ctx, job);
} });
export const forRun = readableQuery({ args: { token: v.string(), runId: v.id("runs"), id: v.optional(v.id("computeJobs")) }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  if (a.id) {
    const job = await ctx.db.get(a.id);
    if (!job || job.chatId !== run.chatId) throw new Error("Job is not in this chat");
    return detail(ctx, job);
  }
  return (await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", run.chatId)).order("desc").take(50)).map(summary);
} });
export const targets = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  const { chat, u } = await requireChat(ctx, chatId);
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  const rows = (await Promise.all(members.map(m => ctx.db.query("runners").withIndex("by_owner", q => q.eq("ownerLogin", m.githubLogin)).collect()))).flat();
  return rows.filter(r => r.computeBackend === "local-process" && r.online && r.lastSeen > Date.now() - 90_000 && (r.ownerLogin === u.githubLogin || r.allowSharedRuns)).map(r => ({ id: r._id, name: r.name, backend: r.computeBackend!, openfoam:r.openfoam ?? null }));
} });

// Connector APIs. Claim serializes work per local runner; disconnection does not fail a job.
export const pending = readableQuery({ args: { token: v.string() }, handler: async (ctx, { token }) => {
  const states = [...executing, "queued"];
  if (await isGatewayToken(token))
    return (await Promise.all([
      ...states.map(state => ctx.db.query("computeJobs").withIndex("by_backend_state", q => q.eq("backend", "modal-sandbox").eq("state", state)).take(100)),
      ctx.db.query("computeJobs").withIndex("by_backend_release", q => q.eq("backend", "modal-sandbox").eq("awaitingRelease", true)).take(100),
    ])).flat();
  const runner = await runnerForToken(ctx, token);
  return (await Promise.all(states.map(state => ctx.db.query("computeJobs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", state)).take(100)))).flat().filter(j => j.backend === "local-process");
} });
export const claim = readableMutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job, runner } = await workerAccess(ctx, a.token, a.id);
  if (job.state !== "queued") return false;
  if (!runner) {
    // The gateway runs cloud jobs side by side. One whose requester lost access ends here, unlaunched.
    try { await chatAccess(ctx, job.chatId, job.requestedBy); }
    catch (e) {
      const now = Date.now(), billing = await settle(ctx, job, now);
      await ctx.db.patch(job._id, { state: "failed", error: (e as Error).message, endedAt: now, updatedAt: now, ...(billing ? { billing } : {}) }); return false;
    }
    await ctx.db.patch(job._id, { state: "preparing", startedAt: Date.now(), updatedAt: Date.now() }); return true;
  }
  await targetAccess(ctx, job.chatId, runner._id, job.requestedBy);
  for (const state of executing) if ((await ctx.db.query("computeJobs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", state)).collect()).some(j => j.backend === "local-process")) return false;
  await ctx.db.patch(job._id, { state: "preparing", startedAt: Date.now(), updatedAt: Date.now() }); return true;
} });
export const inputs = readableQuery({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  await chatAccess(ctx, job.chatId, job.requestedBy);
  return Promise.all(JobSpec.parse(job.spec).inputs.map(async input => {
    const asset = await ctx.db.get(input.assetId as Id<"computeAssets">);
    if (!asset || asset.chatId !== job.chatId) throw new Error("Missing input asset");
    const url = await ctx.storage.getUrl(asset.storageId); if (!url) throw new Error("Input has expired");
    return { path: input.path, url, size: asset.size, sha256: asset.sha256 };
  }));
} });
/** Resume publication after the owning runner has rebuilt a stack-overflowed
 * simulation export from its retained solver files. Never launches a new solve. */
export const resumeSimulationExport = readableMutation({ args: {token:v.string(),id:v.id("computeJobs")}, handler:async(ctx,a)=>{
  const {job}=await workerAccess(ctx,a.token,a.id);
  await chatAccess(ctx,job.chatId,job.requestedBy);
  if(job.cancelRequestedAt)throw new Error("Cancelled jobs cannot resume publication");
  if(job.state==="publishing"||job.state==="succeeded")return false;
  if(job.state!=="failed"||!job.handle||job.spec.simulation?.stage!=="solve"||!job.log.includes("Maximum call stack size exceeded"))throw new Error("Job is not a recoverable simulation export failure");
  await ctx.db.patch(job._id,{state:"publishing",error:null,endedAt:undefined,updatedAt:Date.now(),log:(job.log+"\nExport recovery requested from retained solver files; solver is not rerun.\n").slice(-16000)});
  return true;
} });

export const report = readableMutation({ args: { token: v.string(), id: v.id("computeJobs"), state: v.union(v.literal("running"), v.literal("publishing"), v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")), log: v.string(), error: v.union(v.string(), v.null()), exitCode: v.optional(v.union(v.number(), v.null())), handle: v.optional(v.object({ backend: v.string(), id: v.string() })) }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (jobFinished(job.state)) return;
  if (!executing.includes(job.state)) throw new Error("Job has not been claimed");
  if (job.state === "publishing" && a.state === "running") throw new Error("Job is already publishing");
  if (a.handle && (a.handle.backend !== job.backend || (job.handle && job.handle.id !== a.handle.id))) throw new Error("Execution handle mismatch");
  const state = job.cancelRequestedAt && jobFinished(a.state) ? "cancelled" : a.state;
  if (state === "succeeded") {
    const spec = JobSpec.parse(job.spec), assets = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
    if (spec.kind === "process" && spec.outputs.some(p => !assets.some(a => a?.path === p))) throw new Error("Outputs are not yet published");
    if (spec.kind === "environment" && !job.results) throw new Error("Results are not yet published");
  }
  const now = Date.now();
  let billing = job.billing, error = a.error?.slice(0, 2000) ?? null, cancelRequestedAt = job.cancelRequestedAt;
  const machine = !!(job.handle ?? a.handle), finished = jobFinished(state);
  if (billing) {
    // Metering runs from the launch the gateway recorded before creating the machine, never before the
    // claim; without one, from the start of the launch window the machine must have been staged within.
    // A job that reaches what approval authorized is stopped on the gateway's next pass; a finished one
    // settles once its machine is released.
    const claimed = job.startedAt ?? now, launchedAt = job.launchedAt ?? now - CLOUD_LAUNCH_WINDOW_SECONDS * 1000;
    if (!billing.meteredFrom && a.handle) billing = { ...billing, meteredFrom: Math.min(now, Math.max(claimed, launchedAt)) };
    billing = finished && !machine ? await settle(ctx, { ...job, billing }, now) : { ...billing, spentCents: metered(billing, now) };
    if (billing && billing.spentCents >= billing.authorizedCents && (state === "cancelled" || !finished)) {
      cancelRequestedAt ??= now;
      error = `Stopped at its authorized limit of ${formatCents(billing.authorizedCents)}`;
    }
  }
  await ctx.db.patch(job._id, { state, log: a.log.slice(-16000), error, updatedAt: now, ...(a.handle ? { handle: a.handle } : {}), ...(a.exitCode !== undefined ? { exitCode: a.exitCode } : {}), ...(jobFinished(state) ? { endedAt: now } : {}), ...(billing ? { billing } : {}), ...(cancelRequestedAt ? { cancelRequestedAt } : {}), ...(billing && finished && machine ? { awaitingRelease: true } : {}) });
} });
/**
 * The gateway is about to create a cloud job's machine. Recorded first, so metering starts here and a
 * machine that ran and expired while the gateway was away is never launched a second time.
 */
export const launching = readableMutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job, runner } = await workerAccess(ctx, a.token, a.id);
  if (runner) throw new Error("Only the gateway launches cloud machines");
  if (jobFinished(job.state) || job.handle) throw new Error("Job is not waiting for a machine");
  await ctx.db.patch(job._id, { launchedAt: Date.now() });
} });
/** The gateway is about to stop a finished job's machine. If it cannot say when the machine stopped, spend settles here. */
export const releasing = readableMutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job, runner } = await workerAccess(ctx, a.token, a.id);
  if (runner) throw new Error("Only the gateway releases cloud machines");
  if (!jobFinished(job.state)) throw new Error("Job has not finished");
  if (!job.releasingAt) await ctx.db.patch(job._id, { releasingAt: Date.now() });
} });
/** The gateway confirmed a finished cloud job's machine has stopped: its metered spend settles now. */
export const released = readableMutation({ args: { token: v.string(), id: v.id("computeJobs"), stoppedAt: v.optional(v.number()) }, handler: async (ctx, a) => {
  const { job, runner } = await workerAccess(ctx, a.token, a.id);
  if (runner) throw new Error("Only the gateway releases cloud machines");
  if (!jobFinished(job.state)) throw new Error("Job has not finished");
  // Settled at the confirmed stop, or when the release began if the machine had already stopped, so a
  // release retried after an outage charges nothing for the outage.
  const now = Date.now(), stoppedAt = Math.min(now, Math.max(job.billing?.meteredFrom ?? 0, a.stoppedAt ?? job.releasingAt ?? now));
  const billing = await settle(ctx, job, stoppedAt);
  await ctx.db.patch(job._id, { awaitingRelease: undefined, updatedAt: now, ...(billing ? { billing } : {}) });
} });

async function asset(ctx: MutationCtx, chatId: Id<"chats">, author: string, storageId: Id<"_storage">, path: string, jobId?: Id<"computeJobs">) {
  JobPath.parse(path);
  const meta = await ctx.db.system.get(storageId);
  if (!meta || meta.size > MAX_COMPUTE_FILE_BYTES) throw new Error("Compute files must be 20 MB or smaller");
  const prior = await ctx.db.query("computeAssets").withIndex("by_storage", q => q.eq("storageId", storageId)).first();
  if (prior) {
    if (prior.chatId !== chatId || prior.author !== author || prior.path !== path || prior.jobId !== jobId) throw new Error("Storage already belongs to another asset");
    return prior._id;
  }
  const file = await ctx.db.query("files").withIndex("by_storage", q => q.eq("storageId", storageId)).first();
  if (file && (file.chatId !== chatId || !file.messageId)) throw new Error("Storage belongs to another file");
  return ctx.db.insert("computeAssets", { chatId, storageId, path, author, size: meta.size, sha256: meta.sha256, ...(jobId ? { jobId } : {}) });
}
export const importFile = mutation({ args: { fileId: v.id("files"), path: v.string() }, handler: async (ctx, a) => {
  const file = await ctx.db.get(a.fileId); if (!file || !file.messageId) throw new Error("Choose a file already shared in chat");
  const { u } = await requireChat(ctx, file.chatId);
  // Preserve the first immutable asset; remapping belongs in the job input manifest.
  const prior = await ctx.db.query("computeAssets").withIndex("by_storage", q => q.eq("storageId", file.storageId)).first();
  return prior?._id ?? asset(ctx, file.chatId, u.githubLogin!, file.storageId, a.path);
} });
/** Imported 3-D models: the pane uploads a normalized binary STL and keeps it as a compute asset of this chat. */
export const modelUploadUrl = mutation({ args: { chatId: v.id("chats") }, handler: async (ctx, a) => {
  await requireChat(ctx, a.chatId); return ctx.storage.generateUploadUrl();
} });
async function modelAsset(ctx: MutationCtx, chatId: Id<"chats">, author: string, storageId: Id<"_storage">) {
  const meta = await ctx.db.system.get(storageId);
  if (!meta || meta.size < 84 || (meta.size - 84) % 50 !== 0 || meta.size > 84 + 50 * MODEL_MAX_TRIANGLES) throw new Error("Upload a normalized binary STL of at most 200,000 triangles");
  const id = await asset(ctx, chatId, author, storageId, "model.stl");
  return { assetId: id, sha256: meta.sha256, size: meta.size };
}
export const stageModel = mutation({ args: { chatId: v.id("chats"), storageId: v.id("_storage") }, handler: async (ctx, a) => {
  const { u } = await requireChat(ctx, a.chatId); return modelAsset(ctx, a.chatId, u.githubLogin!, a.storageId);
} });
export const stageModelForRun = readableMutation({ args: { token: v.string(), runId: v.id("runs"), storageId: v.id("_storage") }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId); return modelAsset(ctx, run.chatId, run.dispatchedBy, a.storageId);
} });
/** Download links for the imported models a study draws, for anyone who can read their chat. */
export const modelFiles = query({ args: { assetIds: v.array(v.string()) }, handler: async (ctx, a) => {
  if (a.assetIds.length > 8) throw new Error("A study has at most 8 bodies");
  return (await Promise.all(a.assetIds.map(async raw => {
    const id = ctx.db.normalizeId("computeAssets", raw), row = id && await ctx.db.get(id);
    if (!row || row.path !== "model.stl") return null;
    await requireChat(ctx, row.chatId);
    const url = await ctx.storage.getUrl(row.storageId);
    return url ? { assetId: raw, url, size: row.size } : null;
  }))).filter(r => r !== null);
} });
export const inputUploadUrl = readableMutation({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  await runAccess(ctx, a.token, a.runId); return ctx.storage.generateUploadUrl();
} });
export const stageInput = readableMutation({ args: { token: v.string(), runId: v.id("runs"), storageId: v.id("_storage"), path: v.string() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId); return asset(ctx, run.chatId, run.dispatchedBy, a.storageId, a.path);
} });
export const outputUploadUrl = readableMutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (job.state !== "publishing" || job.cancelRequestedAt) throw new Error("Job is not publishing");
  return ctx.storage.generateUploadUrl();
} });
export const publishOutput = readableMutation({ args: { token: v.string(), id: v.id("computeJobs"), path: v.string(), storageId: v.id("_storage") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  const published = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
  const prior = published.find(p => p?.path === a.path); if (prior) return prior._id;
  const spec = JobSpec.parse(job.spec);
  const requested = spec.kind === "process" ? spec.outputs.includes(a.path) : a.path.startsWith(`${RESULTS_ROOT}/`) && job.outputs.length < MAX_RESULT_FILES;
  if (job.state !== "publishing" || job.cancelRequestedAt || !requested) throw new Error("Output was not requested");
  const id = await asset(ctx, job.chatId, job.requestedBy, a.storageId, a.path, job._id);
  await ctx.db.patch(job._id, { outputs: [...job.outputs, id], updatedAt: Date.now() }); return id;
} });
/** An environment job's results: the validated manifest, after every file it names was published or listed as too large. */
export const publishResults = readableMutation({ args: { token: v.string(), id: v.id("computeJobs"), manifest: v.any(), unpublished: v.array(v.object({ path: v.string(), reason: v.string() })) }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (JobSpec.parse(job.spec).kind !== "environment") throw new Error("Only environment jobs publish results");
  if (job.state !== "publishing" || job.cancelRequestedAt) throw new Error("Job is not publishing");
  const manifest = a.manifest === null ? null : ResultsManifest.parse(a.manifest);
  if (manifest) {
    const published = new Set((await Promise.all(job.outputs.map(id => ctx.db.get(id)))).map(asset => asset?.path));
    if (!published.has(`${RESULTS_ROOT}/manifest.json`)) throw new Error("Publish beam/out/manifest.json first");
  }
  if (a.unpublished.length > 1024 || a.unpublished.some(u => !u.path.startsWith(`${RESULTS_ROOT}/`))) throw new Error("Invalid unpublished list");
  await ctx.db.patch(job._id, { results: { manifest, unpublished: a.unpublished.map(u => ({ path: u.path, reason: u.reason.slice(0, 200) })) }, updatedAt: Date.now() });
} });
export const hasOutput = readableQuery({ args: { token: v.string(), id: v.id("computeJobs"), path: v.string() }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  const assets = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
  return assets.some(asset => asset?.path === a.path) || !!(await largeObject(ctx, job._id, a.path));
} });
export const findRequest = readableQuery({ args: { token: v.string(), runId: v.id("runs"), requestKey: v.string() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  return ctx.db.query("computeJobs").withIndex("by_request", q => q.eq("chatId", run.chatId).eq("requestedBy", run.dispatchedBy).eq("requestKey", a.requestKey)).first();
} });

// Large outputs: result files over the Convex storage limit go to the object store (R2). Convex signs
// the uploader's multipart requests and viewers' downloads, and records each finished upload; it never
// reads or writes an object itself. See packages/contracts/src/largeOutputs.ts.
const largeObjects = (ctx: Ctx, jobId: Id<"computeJobs">) => ctx.db.query("computeObjects").withIndex("by_job", q => q.eq("jobId", jobId)).collect();
const largeObject = (ctx: Ctx, jobId: Id<"computeJobs">, path: string) => ctx.db.query("computeObjects").withIndex("by_job", q => q.eq("jobId", jobId).eq("path", path)).first();
/** Signed upload URLs outlast the slowest part; a download link lasts 15 minutes. */
const UPLOAD_URL_SECONDS = 3600, DOWNLOAD_URL_SECONDS = 900;
const largeArgs = { token: v.string(), id: v.id("computeJobs"), path: v.string(), size: v.number() };
type LargeArgs = { token: string; id: Id<"computeJobs">; path: string; size: number };

/**
 * Whether this worker may put this file in the object store: its job, publishing, an environment job
 * whose manifest is already published, a file under beam/out over the Convex limit. A file past a cap
 * is not an error; `refusal` says why it stays where it was written.
 */
export async function largeOutputTarget(ctx: Ctx, a: LargeArgs) {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (JobSpec.parse(job.spec).kind !== "environment") throw new Error("Only environment jobs publish large outputs");
  if (job.state !== "publishing" || job.cancelRequestedAt) throw new Error("Job is not publishing");
  const path = JobPath.parse(a.path);
  if (!path.startsWith(`${RESULTS_ROOT}/`)) throw new Error("Output was not requested");
  if (!Number.isSafeInteger(a.size) || a.size <= MAX_COMPUTE_FILE_BYTES) throw new Error("Outputs of 20 MB or less are published to Convex storage");
  const assets = (await Promise.all(job.outputs.map(id => ctx.db.get(id)))).filter(x => x !== null);
  const manifest = assets.find(x => x.path === `${RESULTS_ROOT}/manifest.json`);
  if (!manifest) throw new Error("Publish beam/out/manifest.json first");
  const objects = await largeObjects(ctx, job._id), found = objects.find(o => o.path === path);
  const prior = found ? { id: found._id, size: found.size, sha256: found.sha256, key: found.key } : null;
  const refusal = a.size > MAX_LARGE_OUTPUT_BYTES ? largeOutputReasons.tooLarge()
    : !prior && objects.reduce((n, o) => n + o.size, 0) + a.size > MAX_JOB_LARGE_OUTPUT_BYTES ? largeOutputReasons.jobTotal()
    : !prior && assets.length + objects.length >= MAX_RESULT_FILES ? `past the ${MAX_RESULT_FILES}-file limit`
    : null;
  return {
    key: largeOutputKey(job._id, path), prior, refusal, manifest: manifest.storageId,
    json: assets.filter(x => x.path.endsWith(".json")).map(x => ({ path: x.path, storageId: x.storageId })),
  };
}
type LargeTarget = Awaited<ReturnType<typeof largeOutputTarget>>;
export const largeOutputTargetQuery = internalQuery({ args: largeArgs, handler: largeOutputTarget });

/**
 * The file must be one the published manifest names, or a buffer one of its published previews
 * describes, at exactly the length the preview gives. Read from Convex storage, so the check rests on
 * what was published rather than on the uploader's word.
 */
export async function namedByManifest(read: (id: Id<"_storage">) => Promise<string>, target: Pick<LargeTarget, "manifest" | "json">, path: string, size: number) {
  const manifest = ResultsManifest.parse(JSON.parse(await read(target.manifest)));
  const rel = path.slice(RESULTS_ROOT.length + 1);
  if (resultPaths(manifest).includes(rel)) return;
  for (const field of manifest.fields) {
    const preview = target.json.find(x => x.path === `${RESULTS_ROOT}/${field.preview}`);
    if (!preview) continue;
    const lengths = previewByteLengths(FieldPreview.parse(JSON.parse(await read(preview.storageId))));
    if (!Object.prototype.hasOwnProperty.call(lengths, rel)) continue;
    if (lengths[rel] !== size) throw new Error(previewLengthMismatch(rel, size, lengths[rel]!));
    return;
  }
  throw new Error("Output was not requested");
}
async function largeOutputAccess(ctx: ActionCtx, a: LargeArgs): Promise<LargeTarget> {
  const target: LargeTarget = await ctx.runQuery(internal.compute.largeOutputTargetQuery, { token: a.token, id: a.id, path: a.path, size: a.size });
  await namedByManifest(async id => {
    const blob = await ctx.storage.get(id);
    if (!blob) throw new Error("A published result is missing from storage");
    return blob.text();
  }, target, a.path, a.size);
  return target;
}
function requireStore() {
  const store = objectStore();
  if (!store) throw new Error("Large-output storage is not configured");
  return store;
}
/** Step 1 for the uploader: whether this file goes to the object store, and a URL that starts its multipart upload. */
export const startLargeOutput = readableAction({ args: largeArgs, handler: async (ctx, a): Promise<LargeOutputStart> => {
  const target = await largeOutputAccess(ctx, a);
  if (target.prior) throw new Error("This output is already published");
  if (target.refusal) return { ok: false, reason: target.refusal };
  const store = objectStore();
  if (!store) return { ok: false, reason: largeOutputReasons.notConfigured() };
  return { ok: true, key: target.key, partBytes: LARGE_OUTPUT_PART_BYTES, createUrl: await signObject(store, "POST", target.key, { uploads: "" }, UPLOAD_URL_SECONDS) };
} });
/** Step 2, in batches: URLs for the next parts, and fresh ones to complete or abort the upload. */
export const largeOutputUrls = readableAction({ args: { ...largeArgs, uploadId: v.string(), parts: v.array(v.number()) }, handler: async (ctx, a): Promise<LargeOutputUrls> => {
  const uploadId = UploadId.parse(a.uploadId), parts = PartNumbers.parse(a.parts);
  const target = await largeOutputAccess(ctx, a);
  if (target.prior) throw new Error("This output is already published");
  if (target.refusal) throw new Error(target.refusal);
  const count = planParts(a.size, LARGE_OUTPUT_PART_BYTES).length;
  if (parts.some(n => n > count)) throw new Error(`This file uploads in ${count} parts`);
  const store = requireStore(), sign = (method: "PUT" | "POST" | "DELETE", query: Record<string, string>) => signObject(store, method, target.key, query, UPLOAD_URL_SECONDS);
  return {
    parts: await Promise.all(parts.map(async partNumber => ({ partNumber, url: await sign("PUT", { partNumber: String(partNumber), uploadId }) }))),
    completeUrl: await sign("POST", { uploadId }), abortUrl: await sign("DELETE", { uploadId }),
  };
} });
/** Step 3: the upload is complete; record it as one of the job's outputs. Idempotent for the same file. */
export const recordLargeOutput = readableAction({ args: { ...largeArgs, sha256: v.string(), key: v.string() }, handler: async (ctx, a): Promise<Id<"computeObjects">> => {
  await largeOutputAccess(ctx, a);
  requireStore();
  return ctx.runMutation(internal.compute.insertLargeOutputMutation, { token: a.token, id: a.id, path: a.path, size: a.size, key: a.key, sha256: Sha256Hex.parse(a.sha256) });
} });
export async function insertLargeOutput(ctx: MutationCtx, a: LargeArgs & { key: string; sha256: string }): Promise<Id<"computeObjects">> {
  // Checked again here, in the transaction that records it: the job may have been cancelled since.
  const target = await largeOutputTarget(ctx, a);
  if (a.key !== target.key) throw new Error("The key does not match this output");
  if (target.prior) {
    if (target.prior.size === a.size && target.prior.sha256 === a.sha256) return target.prior.id;
    throw new Error("A different file is already published at this path");
  }
  if (target.refusal) throw new Error(target.refusal);
  const job = (await ctx.db.get(a.id))!, now = Date.now();
  const id = await ctx.db.insert("computeObjects", { chatId: job.chatId, jobId: job._id, path: a.path, key: target.key, size: a.size, sha256: Sha256Hex.parse(a.sha256), author: job.requestedBy, createdAt: now });
  await ctx.db.patch(job._id, { updatedAt: now });
  return id;
}
export const insertLargeOutputMutation = internalMutation({ args: { ...largeArgs, sha256: v.string(), key: v.string() }, handler: insertLargeOutput });

/** A large output's key, for anyone who can read the job's chat. */
export async function largeOutputForViewer(ctx: QueryCtx, a: { id: Id<"computeJobs">; path: string }) {
  const job = await ctx.db.get(a.id); if (!job) throw new Error("Job not found");
  await requireChat(ctx, job.chatId);
  const object = await largeObject(ctx, job._id, a.path);
  if (!object) throw new Error("This output is not in large-output storage");
  return { key: object.key, name: (a.path.split("/").at(-1) ?? "output").replace(/[^\w.-]/g, "_") };
}
export const largeOutputForViewerQuery = internalQuery({ args: { id: v.id("computeJobs"), path: v.string() }, handler: largeOutputForViewer });
/** A download link for a large output, valid for 15 minutes. */
export const outputUrl = readableAction({ args: { id: v.id("computeJobs"), path: v.string() }, handler: async (ctx, a): Promise<{ url: string; expiresAt: number }> => {
  const object: { key: string; name: string } = await ctx.runQuery(internal.compute.largeOutputForViewerQuery, a);
  const url = await signObject(requireStore(), "GET", object.key, { "response-content-disposition": `attachment; filename="${object.name}"` }, DOWNLOAD_URL_SECONDS);
  return { url, expiresAt: Date.now() + DOWNLOAD_URL_SECONDS * 1000 };
} });
