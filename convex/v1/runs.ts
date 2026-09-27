import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireLayer } from "../layers";
import { requireMemberLogin } from "../lib";
import { visibleChats } from "../chats";
import { LIVE, respondAs } from "../runs";
import { events as publicEvents, readableChat, run } from "./shape";

const ENDED = ["landed", "failed", "interrupted"] as const;

export const list = query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    await readableChat(ctx, chatId, login);
    const rows = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    return Promise.all(rows.map((r) => run(ctx, r)));
  },
});

/**
 * What every agent in a workspace is doing: its live runs, plus each chat's latest run per outcome, so a
 * layer sees a run end and how. Indexed by state; reading whole chat histories would rerun on every old run.
 */
export const active = query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireLayer(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    const live = [], ended = [];
    for (const c of await visibleChats(ctx, workspaceId, login)) {
      for (const state of LIVE) live.push(...await ctx.db.query("runs").withIndex("by_chat_state", (q) => q.eq("chatId", c._id).eq("state", state)).collect());
      for (const state of ENDED) {
        const last = await ctx.db.query("runs").withIndex("by_chat_state", (q) => q.eq("chatId", c._id).eq("state", state)).order("desc").first();
        if (last) ended.push(last);
      }
    }
    return { live: await Promise.all(live.map((r) => run(ctx, r))), ended: await Promise.all(ended.map((r) => run(ctx, r))) };
  },
});

/** One run's events in order. Fold them with the SDK's runView, the same reducer the plain apps use. */
export const events = query({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const { login } = await requireLayer(ctx, token);
    const r = await ctx.db.get(runId);
    if (!r) throw new Error("no such run");
    await readableChat(ctx, r.chatId, login);
    return publicEvents(await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect());
  },
});

export const eventsForChat = query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    await readableChat(ctx, chatId, login);
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    const out: Record<string, ReturnType<typeof publicEvents>> = {};
    for (const r of runs) out[r._id] = publicEvents(await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", r._id)).collect());
    return out;
  },
});

/** Answer an open question or approval. Anyone who can read the chat may, as in the plain apps. */
export const respond = mutation({
  args: { token: v.string(), runId: v.id("runs"), requestId: v.string(), decision: v.string() },
  handler: async (ctx, { token, runId, requestId, decision }) => {
    const { login } = await requireLayer(ctx, token, "run:respond");
    const r = await ctx.db.get(runId);
    if (!r) throw new Error("no such run");
    await readableChat(ctx, r.chatId, login);
    if (!(r.openRequests ?? []).includes(requestId)) throw new Error("that question is not open");
    if (decision.length > 20_000) throw new Error("answer too long");
    await respondAs(ctx, r, login, requestId, decision);
    return null;
  },
});

/** Ask a live run to stop. The runner still commits and pushes what it has, as always. */
export const interrupt = mutation({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const { login } = await requireLayer(ctx, token, "run:interrupt");
    const r = await ctx.db.get(runId);
    if (!r) throw new Error("no such run");
    await readableChat(ctx, r.chatId, login);
    if (LIVE.has(r.state) && !r.interruptRequestedAt) await ctx.db.patch(runId, { interruptRequestedAt: Date.now() });
    return null;
  },
});
