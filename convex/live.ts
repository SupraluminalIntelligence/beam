import { v } from "convex/values";
import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { readableMutation, requireChat } from "./lib";
import { jobSimulationId, runAccess, workerAccess } from "./compute";
import { draftName, workingSimulation } from "./drafts";
import { LIVE_LIMITS, LiveView } from "../packages/contracts/src/live";

export { draftName };

/**
 * Live views: what the runner reads from the solver's own output while the work happens. Two sources:
 * an agent's work on the chat's machine (one view per simulation), and each running job on this
 * computer (one view per job, kept after it ends beside its results). Each belongs to a simulation:
 * the machine's to the one the agent is working on, or a draft made for it the first time the machine
 * does real work; a job's to its own.
 */
type Ctx = QueryCtx | MutationCtx;
const ACTIVE = ["preparing", "running", "publishing"];

function parsed(view: unknown) {
  const v = LiveView.parse(view);
  if (JSON.stringify(v).length > LIVE_LIMITS.bytes) throw new Error("Live view too large");
  return v;
}
const rows = (ctx: Ctx, id: Id<"simulationCases">) => ctx.db.query("liveViews").withIndex("by_simulation", q => q.eq("simulationId", id)).collect();
const shown = (row: Doc<"liveViews">) => { const view = LiveView.safeParse(row.view); return view.success ? { view: view.data, updatedAt: row.updatedAt } : null; };

/** The runner's latest reading of the machine, for the simulation the agent is working on. */
export const reportMachine = readableMutation({ args: { token: v.string(), runId: v.id("runs"), view: v.any() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  const view = parsed(a.view);
  const chat = await ctx.db.get(run.chatId);
  if (!chat) throw new Error("Chat not found");
  const sim = await workingSimulation(ctx, chat, run.dispatchedBy, run, draftName(view.case.path, chat.title)), now = Date.now();
  const row = (await rows(ctx, sim._id)).find(r => r.source === "machine");
  if (row) await ctx.db.patch(row._id, { view, updatedAt: now });
  else await ctx.db.insert("liveViews", { simulationId: sim._id, chatId: run.chatId, source: "machine", view, updatedAt: now });
  if (sim.draft) await ctx.db.patch(sim._id, { updatedAt: now });
  return { simulationId: sim._id, draft: !!sim.draft };
} });

/** The runner's latest reading of a running job's working directory. Ignored once the job has ended, or for a job of no simulation (a study's). */
export const reportJob = readableMutation({ args: { token: v.string(), id: v.id("computeJobs"), view: v.any() }, handler: async (ctx, a) => {
  const { job } = await workerAccess(ctx, a.token, a.id);
  const simulationId = jobSimulationId(job);
  if (!ACTIVE.includes(job.state) || !simulationId) return null;
  const view = parsed(a.view), now = Date.now();
  const row = await ctx.db.query("liveViews").withIndex("by_job", q => q.eq("jobId", job._id)).first();
  if (row) await ctx.db.patch(row._id, { view, updatedAt: now });
  else await ctx.db.insert("liveViews", { simulationId, chatId: job.chatId, source: "job", jobId: job._id, view, updatedAt: now });
  return { simulationId };
} });

/** A simulation's machine view, for anyone who can read its chat. */
export const forSimulation = query({ args: { id: v.id("simulationCases") }, handler: async (ctx, { id }) => {
  const sim = await ctx.db.get(id);
  if (!sim) return null;
  await requireChat(ctx, sim.chatId);
  const row = (await rows(ctx, id)).find(r => r.source === "machine");
  return row ? shown(row) : null;
} });

/** The live views of a simulation's jobs, newest first: a running job's, and those kept from jobs that ended. */
export const jobsForSimulation = query({ args: { id: v.id("simulationCases") }, handler: async (ctx, { id }) => {
  const sim = await ctx.db.get(id);
  if (!sim) return [];
  await requireChat(ctx, sim.chatId);
  return (await rows(ctx, id)).filter(r => r.source === "job" && r.jobId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
    .flatMap(r => { const s = shown(r); return s ? [{ jobId: r.jobId!, ...s }] : []; });
} });
