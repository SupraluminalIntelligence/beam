import { v } from "convex/values";
import { query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { readableMutation, requireChat } from "./lib";
import { runAccess } from "./compute";
import { ensureCard } from "./simulations";
import { LIVE_LIMITS, LiveView } from "../packages/contracts/src/live";

/**
 * Live views: what the runner reads from the solver's own output on a chat's machine while an agent
 * works. Each belongs to a simulation: the one the agent is working on (the run's or the chat's current
 * files simulation), or else a draft made for it the first time the machine does real work. Saving v1
 * turns that draft into the simulation (simulations.saveFiles), in the same tab and card.
 */

/** A draft's name until the agent saves v1: the top folder of the case (naca0012 for naca0012/run/coarse). */
export function draftName(casePath: string, chatTitle: string) {
  const top = casePath.split("/").find(p => p && p !== ".") ?? "";
  return (top && !/^(scratch|tmp|temp|work|cases?|runs?)$/i.test(top) ? top : chatTitle || "Draft simulation").slice(0, 100);
}

async function liveTarget(ctx: MutationCtx, run: Doc<"runs">, view: LiveView): Promise<Doc<"simulationCases">> {
  const chat = await ctx.db.get(run.chatId);
  if (!chat) throw new Error("Chat not found");
  for (const id of [run.studyId, chat.activeStudyId]) {
    const sim = id ? await ctx.db.get(id) : null;
    if (sim && sim.chatId === run.chatId && sim.kind === "files") return sim;
  }
  const now = Date.now(), name = draftName(view.case.path, chat.title);
  const id = await ctx.db.insert("simulationCases", { chatId: run.chatId, workspaceId: chat.workspaceId, kind: "files", draft: true, name, config: null, revision: 0, updatedAt: now, updatedBy: run.dispatchedBy });
  const sim = (await ctx.db.get(id))!;
  await ensureCard(ctx, sim, `agent:${run.agentId}`, run._id);
  await ctx.db.patch(run.chatId, { activeStudyId: id });
  await ctx.db.patch(run._id, { studyId: id });
  return sim;
}

/** The runner's latest reading of the machine, for the simulation the agent is working on. */
export const reportMachine = readableMutation({ args: { token: v.string(), runId: v.id("runs"), view: v.any() }, handler: async (ctx, a) => {
  const { run } = await runAccess(ctx, a.token, a.runId);
  const view = LiveView.parse(a.view);
  if (JSON.stringify(view).length > LIVE_LIMITS.bytes) throw new Error("Live view too large");
  const sim = await liveTarget(ctx, run, view), now = Date.now();
  const row = await ctx.db.query("liveViews").withIndex("by_simulation", q => q.eq("simulationId", sim._id)).first();
  if (row) await ctx.db.patch(row._id, { view, updatedAt: now });
  else await ctx.db.insert("liveViews", { simulationId: sim._id, chatId: run.chatId, source: "machine", view, updatedAt: now });
  if (sim.draft) await ctx.db.patch(sim._id, { updatedAt: now });
  return { simulationId: sim._id, draft: !!sim.draft };
} });

/** A simulation's live view, for anyone who can read its chat. */
export const forSimulation = query({ args: { id: v.id("simulationCases") }, handler: async (ctx, { id }) => {
  const sim = await ctx.db.get(id);
  if (!sim) return null;
  await requireChat(ctx, sim.chatId);
  const row = await ctx.db.query("liveViews").withIndex("by_simulation", q => q.eq("simulationId", id)).first();
  if (!row) return null;
  const view = LiveView.safeParse(row.view);
  return view.success ? { view: view.data, updatedAt: row.updatedAt } : null;
} });
