import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  handler: async (ctx, { workspaceId, userId }) => {
    const all = await ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    return all.filter((c) => !c.private || c.members.includes(userId));
  },
});

export const create = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string(), isPrivate: v.boolean(), repo: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", a.workspaceId)).first();
    return ctx.db.insert("chats", {
      workspaceId: a.workspaceId, title: "Untitled", untitled: true, private: a.isPrivate,
      members: [a.userId], agents: null, pinnedAgent: a.isPrivate && agents ? agents._id : null, pinnedRunner: null,
      repo: a.repo, activeBranch: null,
    });
  },
});

export const share = mutation({
  args: { chatId: v.id("chats"), members: v.array(v.string()) },
  handler: async (ctx, { chatId, members }) => {
    // one-way: a shared chat never goes private again; pin clears on share
    await ctx.db.patch(chatId, { private: false, members, pinnedAgent: null });
  },
});
