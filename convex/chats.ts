import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireChat, requireMember } from "./lib";

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const u = await requireMember(ctx, workspaceId);
    const all = await ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    return all.filter((c) => !c.private || c.members.includes(u.githubLogin!)).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});

export const get = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => (await requireChat(ctx, chatId)).chat,
});

/** No modal: creates "Untitled" right away. The first message names it. */
export const create = mutation({
  args: { workspaceId: v.id("workspaces"), isPrivate: v.boolean() },
  handler: async (ctx, { workspaceId, isPrivate }) => {
    const u = await requireMember(ctx, workspaceId);
    const w = await ctx.db.get(workspaceId);
    const firstAgent = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first();
    return ctx.db.insert("chats", {
      workspaceId, title: "Untitled", untitled: true, private: isPrivate,
      members: [u.githubLogin!], agents: null,
      pinnedAgent: isPrivate && firstAgent ? firstAgent._id : null, pinnedRunner: null,
      repo: w && w.repos.length === 1 ? w.repos[0]! : null, activeBranch: null,
      createdBy: u.githubLogin!, lastMessageAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { chatId: v.id("chats"), title: v.string() },
  handler: async (ctx, { chatId, title }) => { await requireChat(ctx, chatId); await ctx.db.patch(chatId, { title, untitled: false }); },
});

export const setRepo = mutation({
  args: { chatId: v.id("chats"), repo: v.string() },
  handler: async (ctx, { chatId, repo }) => {
    const { chat } = await requireChat(ctx, chatId);
    if (chat.activeBranch && chat.repo !== repo) throw new Error("chat already has a branch on " + chat.repo);
    await ctx.db.patch(chatId, { repo });
  },
});

/** One-way. Clears the pinned agent, since team chats dispatch by @mention only. */
export const share = mutation({
  args: { chatId: v.id("chats"), members: v.array(v.string()) },
  handler: async (ctx, { chatId, members }) => {
    const { chat, u } = await requireChat(ctx, chatId);
    const set = Array.from(new Set([u.githubLogin!, ...chat.members, ...members]));
    await ctx.db.patch(chatId, { private: false, members: set, pinnedAgent: null });
  },
});

export const setMembers = mutation({
  args: { chatId: v.id("chats"), members: v.array(v.string()) },
  handler: async (ctx, { chatId, members }) => {
    const { chat, u } = await requireChat(ctx, chatId);
    if (chat.private) throw new Error("share the chat first");
    if (!members.includes(u.githubLogin!) && members.length === 0) throw new Error("a chat needs a member");
    await ctx.db.patch(chatId, { members });
  },
});

export const setAgents = mutation({
  args: { chatId: v.id("chats"), agents: v.union(v.array(v.id("agents")), v.null()) },
  handler: async (ctx, { chatId, agents }) => { await requireChat(ctx, chatId); await ctx.db.patch(chatId, { agents }); },
});

export const pinAgent = mutation({
  args: { chatId: v.id("chats"), agentId: v.union(v.id("agents"), v.null()) },
  handler: async (ctx, { chatId, agentId }) => {
    const { chat } = await requireChat(ctx, chatId);
    if (!chat.private && agentId) throw new Error("only private chats pin a default agent");
    await ctx.db.patch(chatId, { pinnedAgent: agentId });
  },
});

/** Whether agents listen to plain messages here (the router). Default on. */
export const setAutoRoute = mutation({
  args: { chatId: v.id("chats"), on: v.boolean() },
  handler: async (ctx, { chatId, on }) => { await requireChat(ctx, chatId); await ctx.db.patch(chatId, { autoRoute: on }); },
});
