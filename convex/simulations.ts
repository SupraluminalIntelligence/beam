import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { readableMutation, readableQuery, requireChat, requireMember } from "./lib";
import { chatAccess, enqueue, runAccess, summary } from "./compute";
import { MachineId } from "../packages/contracts/src/machines";
import { checkCounts, headlineQuantities, ResultsManifest } from "../packages/contracts/src/results";
import { FilesSetup, Parameters, setupChanges } from "../packages/contracts/src/simulations";
import { SimulationCase } from "../packages/contracts/src/simulation";

/**
 * Simulations: every study is one (kind recipe), and files simulations run a snapshot of files, declared
 * parameters, an environment and a command. Versions are immutable. See packages/contracts/src/simulations.ts.
 */
type Ctx = QueryCtx | MutationCtx;
const kindOf = (s: Doc<"simulationCases">) => s.kind ?? "recipe";
const busy = ["queued", "starting", "working", "landing"];

async function versionsOf(ctx: Ctx, id: Id<"simulationCases">) {
  const rows = await ctx.db.query("simulationRevisions").withIndex("by_study_revision", q => q.eq("studyId", id)).collect();
  return rows.sort((a, b) => a.revision - b.revision).map((r, i, all) => {
    const setup = r.setup ? FilesSetup.parse(r.setup) : null, prior = i ? all[i - 1] : null;
    return {
      version: r.revision, name: r.name, createdAt: r.createdAt, createdBy: r.createdBy, note: r.note ?? null,
      setup, config: r.config ?? null,
      changes: setup && prior?.setup ? setupChanges(FilesSetup.parse(prior.setup), setup) : [],
    };
  });
}

/** A job as a simulation shows it: its version, state, and its results in brief. */
function jobView(job: Doc<"computeJobs">) {
  const s = summary(job), manifest = job.results?.manifest ? ResultsManifest.safeParse(job.results.manifest) : null;
  const version = s.simulationVersion?.version ?? s.simulation?.revision ?? null;
  return {
    ...s, version,
    results: manifest?.success ? { headline: headlineQuantities(manifest.data), checks: checkCounts(manifest.data), flagged: manifest.data.checks.filter(c => c.status === "review" || c.status === "fail") } : null,
    keptOnMachine: job.results?.unpublished.length ?? 0,
  };
}
async function jobsOf(ctx: Ctx, sim: Doc<"simulationCases">) {
  const jobs = await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", sim.chatId)).order("desc").take(200);
  return jobs.filter(j => {
    const s = summary(j);
    return s.simulation?.caseId === sim._id || s.simulationVersion?.caseId === sim._id;
  }).map(jobView);
}
function brief(s: Doc<"simulationCases">, chat: Doc<"chats"> | null) {
  const config = kindOf(s) === "recipe" ? SimulationCase.safeParse(s.config) : null;
  return { id: s._id, name: s.name, kind: kindOf(s), version: s.revision, chatId: s.chatId, chatTitle: chat?.title ?? "", updatedAt: s.updatedAt, updatedBy: s.updatedBy, geometry: config?.success ? config.data.geometry : null };
}

/** Every simulation a member can see in a workspace, newest first: for the sidebar. */
export const list = query({ args: { workspaceId: v.id("workspaces") }, handler: async (ctx, a) => {
  const u = await requireMember(ctx, a.workspaceId);
  const chats = (await ctx.db.query("chats").withIndex("by_workspace", q => q.eq("workspaceId", a.workspaceId)).collect())
    .filter(c => c.state !== "deleted" && (!c.private || c.members.includes(u.githubLogin!)));
  const rows = (await Promise.all(chats.map(async c => (await ctx.db.query("simulationCases").withIndex("by_chat", q => q.eq("chatId", c._id)).collect()).map(s => brief(s, c))))).flat();
  return rows.sort((x, y) => y.updatedAt - x.updatedAt);
} });

/** One simulation with its versions and jobs: for the simulation page and card. */
export const get = query({ args: { id: v.id("simulationCases") }, handler: async (ctx, a) => {
  const sim = await ctx.db.get(a.id); if (!sim) return null;
  const { chat } = await requireChat(ctx, sim.chatId);
  return { ...brief(sim, chat), versions: await versionsOf(ctx, a.id), jobs: await jobsOf(ctx, sim) };
} });

/** What an agent sees: this chat's simulations of both kinds, the working one, and their versions and jobs. */
export const forRun = readableQuery({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  const chat = await ctx.db.get(run.chatId);
  const sims = await ctx.db.query("simulationCases").withIndex("by_chat", q => q.eq("chatId", run.chatId)).collect();
  return {
    activeId: run.studyId === undefined ? chat?.activeStudyId ?? null : run.studyId,
    simulations: await Promise.all(sims.map(async s => ({ ...brief(s, chat), versions: (await versionsOf(ctx, s._id)).slice(-10), jobs: (await jobsOf(ctx, s)).slice(0, 10) }))),
  };
} });

/** The simulation's card in its chat. A recipe card is the study card installed apps already draw. */
async function ensureCard(ctx: MutationCtx, sim: Doc<"simulationCases">, author: string, runId: Id<"runs"> | null) {
  if (sim.cardMessageId) return;
  const cardMessageId = await ctx.db.insert("messages", { chatId: sim.chatId, author, kind: "text", text: `Simulation: ${sim.name}`, runId, simulationId: sim._id, reactions: [] });
  await ctx.db.patch(sim._id, { cardMessageId });
  await ctx.db.patch(sim.chatId, { lastMessageAt: Date.now() });
}

type SaveFiles = { id?: Id<"simulationCases"> | undefined; version?: number | undefined; name: string; setup: unknown; note?: string | undefined };
/** Create a files simulation, or save the next version of one. An unchanged setup and name saves nothing. */
async function saveFiles(ctx: MutationCtx, chatId: Id<"chats">, login: string, a: SaveFiles, run: Doc<"runs"> | null) {
  const setup = FilesSetup.parse(a.setup), name = a.name.trim(), note = a.note?.trim().slice(0, 500) || undefined;
  if (!name || name.length > 100) throw new Error("Use a simulation name of 1–100 characters");
  const chat = await chatAccess(ctx, chatId, login);
  for (const f of setup.files) {
    const asset = await ctx.db.get(f.assetId as Id<"computeAssets">);
    if (!asset || asset.chatId !== chatId) throw new Error(`Setup file ${f.path} is not in this chat; stage it first`);
  }
  const author = run ? `agent:${run.agentId}` : login, now = Date.now();
  if (a.id) {
    const prior = await ctx.db.get(a.id);
    if (!prior || prior.chatId !== chatId || kindOf(prior) !== "files") throw new Error("Simulation unavailable in this chat");
    if (prior.revision !== a.version) throw new Error(`Another edit saved v${prior.revision}. Read the simulation again, then save.`);
    const latest = await ctx.db.query("simulationRevisions").withIndex("by_study_revision", q => q.eq("studyId", a.id!).eq("revision", prior.revision)).first();
    await ensureCard(ctx, prior, author, run?._id ?? null);
    if (prior.name === name && latest?.setup && JSON.stringify(FilesSetup.parse(latest.setup)) === JSON.stringify(setup)) return { id: a.id, version: prior.revision, unchanged: true };
    const version = prior.revision + 1;
    await ctx.db.insert("simulationRevisions", { studyId: a.id, revision: version, name, config: null, setup, ...(note ? { note } : {}), createdAt: now, createdBy: login });
    await ctx.db.patch(a.id, { name, revision: version, updatedAt: now, updatedBy: login });
    return { id: a.id, version, unchanged: false };
  }
  const id = await ctx.db.insert("simulationCases", { chatId, workspaceId: chat.workspaceId, kind: "files", name, config: null, revision: 1, updatedAt: now, updatedBy: login });
  await ctx.db.insert("simulationRevisions", { studyId: id, revision: 1, name, config: null, setup, ...(note ? { note } : {}), createdAt: now, createdBy: login });
  await ensureCard(ctx, (await ctx.db.get(id))!, author, run?._id ?? null);
  await ctx.db.patch(chatId, { activeStudyId: id });
  if (run) await ctx.db.patch(run._id, { studyId: id });
  return { id, version: 1, unchanged: false };
}

type RunVersion = { id: Id<"simulationCases">; version: number; machine: string; requestKey: string };
async function runVersion(ctx: MutationCtx, chatId: Id<"chats">, runnerId: Id<"runners">, login: string, a: RunVersion, needsApproval: boolean, sourceRunId?: Id<"runs">) {
  const sim = await ctx.db.get(a.id);
  if (!sim || sim.chatId !== chatId) throw new Error("Simulation unavailable in this chat");
  if (kindOf(sim) !== "files") throw new Error("Run a recipe simulation's mesh and solve with run_simulation");
  const row = await ctx.db.query("simulationRevisions").withIndex("by_study_revision", q => q.eq("studyId", a.id).eq("revision", a.version)).first();
  if (!row?.setup) throw new Error(`${sim.name} has no v${a.version}`);
  const setup = FilesSetup.parse(row.setup);
  return enqueue(ctx, {
    chatId, runnerId, requestedBy: login, requestKey: a.requestKey, needsApproval, ...(sourceRunId ? { sourceRunId } : {}),
    spec: {
      version: 1, kind: "environment", title: `${sim.name} · v${a.version}`.slice(0, 120), environment: setup.environment, command: setup.command,
      inputs: setup.files.map(f => ({ path: f.path, assetId: f.assetId })), machine: MachineId.parse(a.machine), timeoutSeconds: setup.timeoutSeconds,
      parameters: setup.parameters.map(p => ({ name: p.name, value: p.value, unit: p.unit })), simulation: { caseId: a.id, version: a.version },
    },
  });
}

async function agentRun(ctx: MutationCtx, token: string, runId: Id<"runs">) {
  const { run } = await runAccess(ctx, token, runId);
  if (!["working", "starting"].includes(run.state)) throw new Error("Agent run has ended");
  const agent = await ctx.db.get(run.agentId);
  if (!agent || agent.permissionMode === "plan") throw new Error("Plan mode cannot save or run simulations");
  return { run, agent };
}
const saveArgs = { id: v.optional(v.id("simulationCases")), version: v.optional(v.number()), name: v.string(), setup: v.any(), note: v.optional(v.string()) };
const runArgs = { id: v.id("simulationCases"), version: v.number(), machine: v.string(), requestKey: v.string() };

export const saveVersionForRun = readableMutation({ args: { token: v.string(), runId: v.id("runs"), ...saveArgs }, handler: async (ctx, a) => {
  const { run } = await agentRun(ctx, a.token, a.runId);
  return saveFiles(ctx, run.chatId, run.dispatchedBy, a, run);
} });
export const runVersionForRun = readableMutation({ args: { token: v.string(), runId: v.id("runs"), ...runArgs }, handler: async (ctx, a) => {
  const { run, agent } = await agentRun(ctx, a.token, a.runId);
  return runVersion(ctx, run.chatId, run.runnerId, run.dispatchedBy, a, agent.permissionMode !== "auto", run._id);
} });

/** A person runs a version from the app: explicit authorization, so no approval step. */
export const run = mutation({ args: { runnerId: v.id("runners"), ...runArgs }, handler: async (ctx, a) => {
  const sim = await ctx.db.get(a.id); if (!sim) throw new Error("Simulation not found");
  const { u } = await requireChat(ctx, sim.chatId);
  return runVersion(ctx, sim.chatId, a.runnerId, u.githubLogin!, a, false);
} });

/** A person edits parameters in the app: the next version with everything else unchanged. */
export const saveParameters = mutation({ args: { id: v.id("simulationCases"), version: v.number(), parameters: v.any(), note: v.optional(v.string()) }, handler: async (ctx, a) => {
  const sim = await ctx.db.get(a.id); if (!sim) throw new Error("Simulation not found");
  const { u } = await requireChat(ctx, sim.chatId);
  const runs = await ctx.db.query("runs").withIndex("by_chat", q => q.eq("chatId", sim.chatId)).collect();
  if (runs.some(r => busy.includes(r.state))) throw new Error("The agent is working in this chat. Wait for its turn to finish, or ask it to change the parameters.");
  const row = await ctx.db.query("simulationRevisions").withIndex("by_study_revision", q => q.eq("studyId", a.id).eq("revision", a.version)).first();
  if (!row?.setup) throw new Error(`${sim.name} has no v${a.version}`);
  const setup = FilesSetup.parse(row.setup);
  return saveFiles(ctx, sim.chatId, u.githubLogin!, { id: a.id, version: a.version, name: sim.name, setup: { ...setup, parameters: Parameters.parse(a.parameters) }, note: a.note }, null);
} });
