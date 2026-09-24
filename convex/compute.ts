import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChat } from "./lib";
import { runnerForToken } from "./runners";
import { ownRun } from "./runs";
import { JobPath, ProcessJobSpec, jobFinished, MAX_COMPUTE_FILE_BYTES, MAX_COMPUTE_INPUT_BYTES } from "../packages/contracts/src/compute";
import { SimulationCase, meshKey, simulationOutputs } from "../packages/contracts/src/simulation";

type Ctx = QueryCtx | MutationCtx;
const executing = ["preparing", "running", "publishing"];
const summary = ({ spec, log, ...job }: Doc<"computeJobs">) => ({ ...job, title: ProcessJobSpec.parse(spec).title, simulation: ProcessJobSpec.parse(spec).simulation ?? null });

async function chatAccess(ctx: Ctx, chatId: Id<"chats">, login: string) {
  const chat = await ctx.db.get(chatId);
  const members = chat && await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  if (!chat || chat.state === "deleted" || !members?.some(m => m.githubLogin === login) || (chat.private && !chat.members.includes(login))) throw new Error("Chat access revoked");
  return chat;
}
async function runAccess(ctx: Ctx, token: string, runId: Id<"runs">) {
  const result = await ownRun(ctx, token, runId);
  await chatAccess(ctx, result.run.chatId, result.run.dispatchedBy);
  return result;
}
async function workerAccess(ctx: Ctx, token: string, jobId: Id<"computeJobs">) {
  const runner = await runnerForToken(ctx, token);
  const job = await ctx.db.get(jobId);
  if (!job || job.runnerId !== runner._id) throw new Error("Not this runner's job");
  return { job, runner };
}
async function targetAccess(ctx: Ctx, chatId: Id<"chats">, runnerId: Id<"runners">, login: string) {
  const chat = await chatAccess(ctx, chatId, login);
  const runner = await ctx.db.get(runnerId);
  if (!runner || runner.computeBackend !== "local-process" || !runner.online || runner.lastSeen < Date.now() - 90_000) throw new Error("Compute runner is offline or needs an update");
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  if (!members.some(m => m.githubLogin === runner.ownerLogin) || (runner.ownerLogin !== login && !runner.allowSharedRuns)) throw new Error("Runner is not shared with you");
  return runner;
}

async function enqueue(ctx: MutationCtx, input: { chatId: Id<"chats">; runnerId: Id<"runners">; requestedBy: string; sourceRunId?: Id<"runs">; requestKey: string; spec: unknown; needsApproval: boolean }) {
  const spec = ProcessJobSpec.parse(input.spec);
  if (!input.requestKey.trim() || input.requestKey.length > 160) throw new Error("Invalid request key");
  await chatAccess(ctx, input.chatId, input.requestedBy);
  const existing = await ctx.db.query("computeJobs").withIndex("by_request", q => q.eq("chatId", input.chatId).eq("requestedBy", input.requestedBy).eq("requestKey", input.requestKey)).first();
  if (existing) {
    if (existing.runnerId !== input.runnerId || JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new Error("Request key already used for a different job");
    return existing._id;
  }
  const target = await targetAccess(ctx, input.chatId, input.runnerId, input.requestedBy);
  if(spec.simulation){
    if(!target.openfoam?.ready) throw new Error(target.openfoam?.message ?? "Update this runner to enable OpenFOAM");
    if(target.openfoam.image!==spec.simulation.image)throw new Error("Runner has a different OpenFOAM runtime; update and re-probe it");
    const sim=spec.simulation, model=await ctx.db.get(sim.caseId as Id<"simulationCases">);
    if(!model || model.chatId!==input.chatId || model.revision!==sim.revision || JSON.stringify(SimulationCase.parse(model.config))!==JSON.stringify(sim.config)) throw new Error("Simulation revision changed; reload the case");
    if(sim.stage==="solve"){
      const mesh=await ctx.db.get(sim.meshJobId as Id<"computeJobs">), prior=mesh && ProcessJobSpec.parse(mesh.spec).simulation;
      if(!mesh || mesh.chatId!==input.chatId || mesh.state!=="succeeded" || prior?.stage!=="mesh" || prior.caseId!==sim.caseId || meshKey(prior.config)!==meshKey(sim.config)) throw new Error("Build a matching mesh before solving");
      const asset=await ctx.db.get(spec.inputs[0]!.assetId as Id<"computeAssets">);
      if(!asset || !mesh.outputs.includes(asset._id) || asset.path!=="mesh.json") throw new Error("Use the mesh output of the selected mesh job");
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
  const id = await ctx.db.insert("computeJobs", {
    chatId: input.chatId, runnerId: input.runnerId, requestedBy: input.requestedBy,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), requestKey: input.requestKey,
    backend: "local-process", spec, state: input.needsApproval ? "awaiting-approval" : "queued",
    createdAt: now, updatedAt: now, log: "", error: null, outputs: [],
  });
  if(spec.simulation) await ensureStudyCard(ctx,spec.simulation.caseId as Id<"simulationCases">,input.requestedBy);
  else await ctx.db.insert("messages", { chatId: input.chatId, author: input.requestedBy, kind: "text", text: `Compute job: ${spec.title}`, runId: input.sourceRunId ?? null, computeJobId: id, reactions: [] });
  await ctx.db.patch(input.chatId, { lastMessageAt: now });
  return id;
}

export const submit = mutation({ args: { chatId: v.id("chats"), runnerId: v.id("runners"), requestKey: v.string(), spec: v.any() }, handler: async (ctx, a) => {
  const { u } = await requireChat(ctx, a.chatId);
  return enqueue(ctx, { ...a, requestedBy: u.githubLogin!, needsApproval: false });
} });
export const simulationCases = query({args:{chatId:v.id("chats")},handler:async(ctx,{chatId})=>{
  await requireChat(ctx,chatId);return ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect();
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
    if(!prior||prior.chatId!==chatId)throw new Error("Study unavailable");
    if(prior.revision!==a.revision)throw new Error("Another edit changed this study. Reload before saving.");
    await ensureStudyCard(ctx,a.id,login,sourceRunId);await rememberRevision(ctx,prior);
    if(prior.name===name&&JSON.stringify(SimulationCase.parse(prior.config))===JSON.stringify(config))return{id:a.id,revision:prior.revision};
    const revision=prior.revision+1,updatedAt=Date.now();
    await ctx.db.patch(a.id,{name,config,revision,updatedBy:login,updatedAt});
    await rememberRevision(ctx,{...prior,name,config,revision,updatedAt,updatedBy:login});return{id:a.id,revision};
  }
  const id=await ctx.db.insert("simulationCases",{chatId,name,config,revision:1,updatedBy:login,updatedAt:Date.now()});
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
export const studyContext=query({args:{chatId:v.id("chats")},handler:async(ctx,a)=>{const {chat}=await requireChat(ctx,a.chatId);return{activeStudyId:chat.activeStudyId??null,studies:await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect()};}});
export const workspaceStudies=query({args:{chatId:v.id("chats")},handler:async(ctx,a)=>{
 const {chat,u}=await requireChat(ctx,a.chatId);
 const chats=await ctx.db.query("chats").withIndex("by_workspace",q=>q.eq("workspaceId",chat.workspaceId)).collect();
 const accessible=chats.filter(c=>c.state!=="deleted"&&(!c.private||c.members.includes(u.githubLogin!)));
 return(await Promise.all(accessible.map(async c=>(await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",c._id)).collect()).map(s=>({id:s._id,name:s.name,revision:s.revision,chatId:c._id,chatTitle:c.title,workspaceId:c.workspaceId}))))).flat();
}});
export const study=query({args:{id:v.id("simulationCases")},handler:async(ctx,a)=>{
 const study=await ctx.db.get(a.id);if(!study)return null;await requireChat(ctx,study.chatId);
 const jobs=(await ctx.db.query("computeJobs").withIndex("by_chat",q=>q.eq("chatId",study.chatId)).order("desc").collect()).map(summary).filter(j=>j.simulation?.caseId===a.id);
 const revisions=await ctx.db.query("simulationRevisions").withIndex("by_study_revision",q=>q.eq("studyId",a.id)).collect();
 return{...study,jobs,revisions:revisions.map(({revision,name,createdAt,createdBy})=>({revision,name,createdAt,createdBy}))};
}});
const simulationArgs={caseId:v.id("simulationCases"),revision:v.number(),stage:v.union(v.literal("mesh"),v.literal("solve")),meshJobId:v.optional(v.id("computeJobs")),requestKey:v.string()};
type SubmitCase={caseId:Id<"simulationCases">;revision:number;stage:"mesh"|"solve";meshJobId?:Id<"computeJobs">|undefined;requestKey:string};
async function enqueueSimulation(ctx:MutationCtx,chatId:Id<"chats">,runnerId:Id<"runners">,login:string,a:SubmitCase,needsApproval:boolean,sourceRunId?:Id<"runs">){
  // A retry still resolves to its original immutable job after someone edits the case.
  const prior=await ctx.db.query("computeJobs").withIndex("by_request",q=>q.eq("chatId",chatId).eq("requestedBy",login).eq("requestKey",a.requestKey)).first();
  if(prior){const old=ProcessJobSpec.parse(prior.spec).simulation;if(prior.runnerId!==runnerId||old?.caseId!==a.caseId||old.revision!==a.revision||old.stage!==a.stage||old.meshJobId!==a.meshJobId)throw new Error("Request key already used for a different job");return prior._id;}
  const model=await ctx.db.get(a.caseId);
  if(!model||model.chatId!==chatId||model.revision!==a.revision)throw new Error("Simulation revision changed; reload the case");
  const inputs=[];
  if(a.stage==="solve"&&a.meshJobId){const mesh=await ctx.db.get(a.meshJobId);if(mesh?.chatId!==chatId)throw new Error("Mesh unavailable");for(const id of mesh.outputs){const asset=await ctx.db.get(id);if(asset?.path==="mesh.json")inputs.push({assetId:id,path:"mesh-input.json"});}}
  return enqueue(ctx,{chatId,runnerId,requestedBy:login,requestKey:a.requestKey,needsApproval,...(sourceRunId?{sourceRunId}:{}),spec:{version:1,kind:"process",title:`${model.name} · ${a.stage} · r${model.revision}`,executable:"beam:openfoam",args:[],inputs,outputs:simulationOutputs(a.stage,SimulationCase.parse(model.config)),timeoutSeconds:3600,simulation:{caseId:a.caseId,revision:model.revision,stage:a.stage,config:SimulationCase.parse(model.config),...(a.meshJobId?{meshJobId:a.meshJobId}:{})}}});
}
export const saveSimulation=mutation({args:{chatId:v.id("chats"),...saveCaseArgs},handler:async(ctx,a)=>{const{u}=await requireChat(ctx,a.chatId);if(!a.id){const runs=await ctx.db.query("runs").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect();if(runs.some(r=>["queued","starting","working","landing"].includes(r.state)))throw new Error("Ask the working agent to create the new study, or wait for its turn to finish.");}return saveCase(ctx,a.chatId,u.githubLogin!,a);}});
export const submitSimulation=mutation({args:{chatId:v.id("chats"),runnerId:v.id("runners"),...simulationArgs},handler:async(ctx,a)=>{const{u}=await requireChat(ctx,a.chatId);return enqueueSimulation(ctx,a.chatId,a.runnerId,u.githubLogin!,a,false);}});
export const simulationForRun=query({args:{token:v.string(),runId:v.id("runs"),messageId:v.optional(v.id("messages"))},handler:async(ctx,a)=>{
 const {run}=await runAccess(ctx,a.token,a.runId);const runner=await ctx.db.get(run.runnerId),chat=await ctx.db.get(run.chatId);
 const cases=await ctx.db.query("simulationCases").withIndex("by_chat",q=>q.eq("chatId",run.chatId)).collect();
 const activeStudyId=run.studyId===undefined?chat?.activeStudyId??null:run.studyId;
 const jobs=(await ctx.db.query("computeJobs").withIndex("by_chat",q=>q.eq("chatId",run.chatId)).order("desc").collect()).map(summary).filter(j=>j.simulation);
 const dispatch=await ctx.db.get(a.messageId??run.dispatchMessageId);if(a.messageId&&dispatch?.chatId!==run.chatId)throw new Error("Message unavailable in this chat");
 return{activeStudyId,messageStudyContext:dispatch?.studyContext??null,cases,jobs,runtime:runner?.openfoam??null};
}});
async function simulationRunAccess(ctx:MutationCtx,token:string,runId:Id<"runs">){const{run}=await runAccess(ctx,token,runId);if(!["working","starting"].includes(run.state))throw new Error("Agent run has ended");const agent=await ctx.db.get(run.agentId);if(!agent||agent.permissionMode==="plan")throw new Error("Plan mode cannot edit or submit simulations");return{run,agent};}
export const saveSimulationForRun=mutation({args:{token:v.string(),runId:v.id("runs"),...saveCaseArgs},handler:async(ctx,a)=>{const{run}=await simulationRunAccess(ctx,a.token,a.runId);if(a.id&&a.id!==(run.studyId===undefined?(await ctx.db.get(run.chatId))?.activeStudyId:run.studyId))throw new Error("Select this study explicitly before editing it");return saveCase(ctx,run.chatId,run.dispatchedBy,a,run._id);}});
export const selectSimulationForRun=mutation({args:{token:v.string(),runId:v.id("runs"),caseId:v.id("simulationCases")},handler:async(ctx,a)=>{const {run}=await simulationRunAccess(ctx,a.token,a.runId);await selectStudy(ctx,run.chatId,a.caseId,run.dispatchedBy,run._id);return{activeStudyId:a.caseId};}});
export const submitSimulationForRun=mutation({args:{token:v.string(),runId:v.id("runs"),...simulationArgs},handler:async(ctx,a)=>{const{run,agent}=await simulationRunAccess(ctx,a.token,a.runId);if(a.caseId!==(run.studyId===undefined?(await ctx.db.get(run.chatId))?.activeStudyId:run.studyId))throw new Error("Select this study explicitly before running it");return enqueueSimulation(ctx,run.chatId,run.runnerId,run.dispatchedBy,a,agent.permissionMode!=="auto",run._id);}});
export const submitForRun = mutation({ args: { token: v.string(), runId: v.id("runs"), requestKey: v.string(), spec: v.any() }, handler: async (ctx, a) => {
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
  await targetAccess(ctx, job.chatId, job.runnerId, job.requestedBy);
  await ctx.db.patch(id, { state: "queued", approvedBy: u.githubLogin!, updatedAt: Date.now() });
} });
async function cancelJob(ctx: MutationCtx, id: Id<"computeJobs">) {
  const job = await ctx.db.get(id); if (!job || jobFinished(job.state)) return;
  const now = Date.now();
  await ctx.db.patch(id, { cancelRequestedAt: now, updatedAt: now, ...(["queued", "awaiting-approval"].includes(job.state) ? { state: "cancelled", endedAt: now } : {}) });
}
export const cancel = mutation({ args: { id: v.id("computeJobs") }, handler: async (ctx, { id }) => {
  const job = await ctx.db.get(id); if (!job) throw new Error("Job not found");
  await requireChat(ctx, job.chatId); await cancelJob(ctx, id);
} });
export const cancelForRun = mutation({ args: { token: v.string(), runId: v.id("runs"), id: v.id("computeJobs") }, handler: async (ctx, a) => {
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
    return asset ? { id, path: asset.path, size: asset.size, sha256: asset.sha256, url: await ctx.storage.getUrl(asset.storageId) } : null;
  }));
  return { ...job, spec: ProcessJobSpec.parse(job.spec), runnerName: runner?.name ?? "Runner", runnerOnline: !!runner?.online && runner.lastSeen > Date.now() - 90_000, outputs: outputs.filter(o => o !== null) };
}
export const get = query({ args: { id: v.id("computeJobs") }, handler: async (ctx, { id }) => {
  const job = await ctx.db.get(id); if (!job) return null;
  await requireChat(ctx, job.chatId); return detail(ctx, job);
} });
export const forRun = query({ args: { token: v.string(), runId: v.id("runs"), id: v.optional(v.id("computeJobs")) }, handler: async (ctx, a) => {
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
export const pending = query({ args: { token: v.string() }, handler: async (ctx, { token }) => {
  const runner = await runnerForToken(ctx, token);
  return (await Promise.all([...executing, "queued"].map(state => ctx.db.query("computeJobs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", state)).take(100)))).flat();
} });
export const claim = mutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job, runner } = await workerAccess(ctx, a.token, a.id);
  if (job.state !== "queued") return false;
  await targetAccess(ctx, job.chatId, runner._id, job.requestedBy);
  for (const state of executing) if (await ctx.db.query("computeJobs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", state)).first()) return false;
  await ctx.db.patch(job._id, { state: "preparing", startedAt: Date.now(), updatedAt: Date.now() }); return true;
} });
export const inputs = query({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  await chatAccess(ctx, job.chatId, job.requestedBy);
  return Promise.all(ProcessJobSpec.parse(job.spec).inputs.map(async input => {
    const asset = await ctx.db.get(input.assetId as Id<"computeAssets">);
    if (!asset || asset.chatId !== job.chatId) throw new Error("Missing input asset");
    const url = await ctx.storage.getUrl(asset.storageId); if (!url) throw new Error("Input has expired");
    return { path: input.path, url, size: asset.size, sha256: asset.sha256 };
  }));
} });
/** Resume publication after the owning runner has rebuilt a stack-overflowed
 * simulation export from its retained solver files. Never launches a new solve. */
export const resumeSimulationExport = mutation({ args: {token:v.string(),id:v.id("computeJobs")}, handler:async(ctx,a)=>{
  const {job}=await workerAccess(ctx,a.token,a.id);
  await chatAccess(ctx,job.chatId,job.requestedBy);
  if(job.cancelRequestedAt)throw new Error("Cancelled jobs cannot resume publication");
  if(job.state==="publishing"||job.state==="succeeded")return false;
  if(job.state!=="failed"||!job.handle||job.spec.simulation?.stage!=="solve"||!job.log.includes("Maximum call stack size exceeded"))throw new Error("Job is not a recoverable simulation export failure");
  await ctx.db.patch(job._id,{state:"publishing",error:null,endedAt:undefined,updatedAt:Date.now(),log:(job.log+"\nExport recovery requested from retained solver files; solver is not rerun.\n").slice(-16000)});
  return true;
} });

export const report = mutation({ args: { token: v.string(), id: v.id("computeJobs"), state: v.union(v.literal("running"), v.literal("publishing"), v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")), log: v.string(), error: v.union(v.string(), v.null()), exitCode: v.optional(v.union(v.number(), v.null())), handle: v.optional(v.object({ backend: v.string(), id: v.string() })) }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (jobFinished(job.state)) return;
  if (!executing.includes(job.state)) throw new Error("Job has not been claimed");
  if (job.state === "publishing" && a.state === "running") throw new Error("Job is already publishing");
  if (a.handle && (a.handle.backend !== job.backend || (job.handle && job.handle.id !== a.handle.id))) throw new Error("Execution handle mismatch");
  const state = job.cancelRequestedAt && jobFinished(a.state) ? "cancelled" : a.state;
  if (state === "succeeded") {
    const assets = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
    if (ProcessJobSpec.parse(job.spec).outputs.some(p => !assets.some(a => a?.path === p))) throw new Error("Outputs are not yet published");
  }
  await ctx.db.patch(job._id, { state, log: a.log.slice(-16000), error: a.error?.slice(0,2000) ?? null, updatedAt: Date.now(), ...(a.handle ? { handle: a.handle } : {}), ...(a.exitCode !== undefined ? { exitCode: a.exitCode } : {}), ...(jobFinished(state) ? { endedAt: Date.now() } : {}) });
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
export const inputUploadUrl = mutation({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  await runAccess(ctx, a.token, a.runId); return ctx.storage.generateUploadUrl();
} });
export const stageInput = mutation({ args: { token: v.string(), runId: v.id("runs"), storageId: v.id("_storage"), path: v.string() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId); return asset(ctx, run.chatId, run.dispatchedBy, a.storageId, a.path);
} });
export const outputUploadUrl = mutation({ args: { token: v.string(), id: v.id("computeJobs") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  if (job.state !== "publishing" || job.cancelRequestedAt) throw new Error("Job is not publishing");
  return ctx.storage.generateUploadUrl();
} });
export const publishOutput = mutation({ args: { token: v.string(), id: v.id("computeJobs"), path: v.string(), storageId: v.id("_storage") }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  const published = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
  const prior = published.find(p => p?.path === a.path); if (prior) return prior._id;
  if (job.state !== "publishing" || job.cancelRequestedAt || !ProcessJobSpec.parse(job.spec).outputs.includes(a.path)) throw new Error("Output was not requested");
  const id = await asset(ctx, job.chatId, job.requestedBy, a.storageId, a.path, job._id);
  await ctx.db.patch(job._id, { outputs: [...job.outputs, id], updatedAt: Date.now() }); return id;
} });
export const hasOutput = query({ args: { token: v.string(), id: v.id("computeJobs"), path: v.string() }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  const assets = await Promise.all(job.outputs.map(id => ctx.db.get(id)));
  return assets.some(asset => asset?.path === a.path);
} });
export const findRequest = query({ args: { token: v.string(), runId: v.id("runs"), requestKey: v.string() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  return ctx.db.query("computeJobs").withIndex("by_request", q => q.eq("chatId", run.chatId).eq("requestedBy", run.dispatchedBy).eq("requestKey", a.requestKey)).first();
} });
