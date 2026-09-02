import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Runners subscribe to this for work assigned to them. */
export const queuedFor = query({
  args: { runnerId: v.id("runners") },
  handler: (ctx, { runnerId }) => ctx.db.query("runs").withIndex("by_runner_state", (q) => q.eq("runnerId", runnerId).eq("state", "queued")).collect(),
});

export const forChat = query({
  args: { chatId: v.id("chats") },
  handler: (ctx, { chatId }) => ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
});

export const claim = mutation({
  args: { runId: v.id("runs"), branch: v.string(), worktree: v.string() },
  handler: (ctx, { runId, branch, worktree }) => ctx.db.patch(runId, { state: "starting", branch, worktree, startedAt: Date.now() }),
});

/** Coalesced on the runner side: content deltas batch at ~100ms before this is called. */
export const appendEvents = mutation({
  args: { runId: v.id("runs"), events: v.array(v.any()), fromSeq: v.number() },
  handler: async (ctx, { runId, events, fromSeq }) => {
    let seq = fromSeq;
    for (const event of events) await ctx.db.insert("runEvents", { runId, seq: seq++, event });
    return seq;
  },
});

export const events = query({
  args: { runId: v.id("runs") },
  handler: (ctx, { runId }) => ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
});

export const land = mutation({
  args: { runId: v.id("runs"), state: v.string(), landing: v.any(), resumeCursor: v.any() },
  handler: (ctx, { runId, state, landing, resumeCursor }) => ctx.db.patch(runId, { state, landing, resumeCursor, endedAt: Date.now() }),
});
