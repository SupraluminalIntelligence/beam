import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { me, requireMember } from "./lib";

/** Which chat each person has focused. One chat per person. Client throttles writes. */
export const focus = mutation({
  args: { workspaceId: v.id("workspaces"), chatId: v.union(v.id("chats"), v.null()) },
  handler: async (ctx, { workspaceId, chatId }) => {
    const u = await requireMember(ctx, workspaceId);
    const row = await ctx.db.query("presence").withIndex("by_login", (q) => q.eq("githubLogin", u.githubLogin!)).first();
    if (row) await ctx.db.patch(row._id, { workspaceId, focusedChat: chatId, updatedAt: Date.now() });
    else await ctx.db.insert("presence", { workspaceId, githubLogin: u.githubLogin!, focusedChat: chatId, updatedAt: Date.now() });
  },
});

export const inWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    const cutoff = Date.now() - 2 * 60_000;
    const rows = await ctx.db.query("presence").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    return rows.filter((r) => r.updatedAt > cutoff).map((r) => ({ login: r.githubLogin, chatId: r.focusedChat }));
  },
});

export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const u = await me(ctx).catch(() => null);
    if (!u) return;
    const row = await ctx.db.query("presence").withIndex("by_login", (q) => q.eq("githubLogin", u.githubLogin!)).first();
    if (row) await ctx.db.patch(row._id, { focusedChat: null, updatedAt: 0 });
  },
});
