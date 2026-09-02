import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const register = mutation({
  args: { workspaceId: v.id("workspaces"), ownerId: v.string(), name: v.string(), harnesses: v.any() },
  handler: (ctx, a) => ctx.db.insert("runners", { ...a, online: true, lastSeen: Date.now() }),
});

export const heartbeat = mutation({
  args: { runnerId: v.id("runners"), harnesses: v.any() },
  handler: (ctx, { runnerId, harnesses }) => ctx.db.patch(runnerId, { online: true, lastSeen: Date.now(), harnesses }),
});

export const online = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const cutoff = Date.now() - 60_000;
    return (await ctx.db.query("runners").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).filter((r) => r.lastSeen > cutoff);
  },
});
