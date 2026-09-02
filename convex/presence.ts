import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Which chat each person has focused. One chat per person. Throttled client-side to one write per 20s. */
export const focus = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string(), chatId: v.union(v.id("chats"), v.null()) },
  handler: async (ctx, { workspaceId, userId, chatId }) => {
    const row = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (row) await ctx.db.patch(row._id, { workspaceId, focusedChat: chatId, updatedAt: Date.now() });
    else await ctx.db.insert("presence", { workspaceId, userId, focusedChat: chatId, updatedAt: Date.now() });
  },
});

export const inWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: (ctx, { workspaceId }) => ctx.db.query("presence").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
});
