import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Which simulation work in a chat belongs to. Every job and every live reading belongs to one: the
 * simulation the agent is working on (the run's, or the chat's current files simulation), or else a
 * draft made for it. Saving v1 turns the draft into the simulation (simulations.saveFiles), in the
 * same card and tab. Kept apart from simulations.ts and compute.ts, which both use it.
 */

/** The simulation's card in its chat. A recipe card is the study card installed apps already draw. */
export async function ensureCard(ctx: MutationCtx, sim: Doc<"simulationCases">, author: string, runId: Id<"runs"> | null) {
  if (sim.cardMessageId) return;
  const cardMessageId = await ctx.db.insert("messages", { chatId: sim.chatId, author, kind: "text", text: `Simulation: ${sim.name}`, runId, simulationId: sim._id, reactions: [] });
  await ctx.db.patch(sim._id, { cardMessageId });
  await ctx.db.patch(sim.chatId, { lastMessageAt: Date.now() });
}

/** A draft's name until the agent saves v1: the top folder of the case (naca0012 for naca0012/run/coarse). */
export function draftName(casePath: string, chatTitle: string) {
  const top = casePath.split("/").find(p => p && p !== ".") ?? "";
  return (top && !/^(scratch|tmp|temp|work|cases?|runs?)$/i.test(top) ? top : chatTitle || "Draft simulation").slice(0, 100);
}

/**
 * The files simulation the run (or, without one, the chat) is working on, or a new draft named name,
 * with its card, made the chat's current simulation.
 */
export async function workingSimulation(ctx: MutationCtx, chat: Doc<"chats">, login: string, run: Doc<"runs"> | null, name: string): Promise<Doc<"simulationCases">> {
  for (const id of [run?.studyId, chat.activeStudyId]) {
    const sim = id ? await ctx.db.get(id) : null;
    if (sim && sim.chatId === chat._id && sim.kind === "files") return sim;
  }
  const now = Date.now();
  const id = await ctx.db.insert("simulationCases", { chatId: chat._id, workspaceId: chat.workspaceId, kind: "files", draft: true, name: name.slice(0, 100) || "Draft simulation", config: null, revision: 0, updatedAt: now, updatedBy: login });
  const sim = (await ctx.db.get(id))!;
  await ensureCard(ctx, sim, run ? `agent:${run.agentId}` : login, run?._id ?? null);
  await ctx.db.patch(chat._id, { activeStudyId: id });
  if (run) await ctx.db.patch(run._id, { studyId: id });
  return sim;
}
