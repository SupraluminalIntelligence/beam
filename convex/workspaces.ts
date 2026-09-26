import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { me, requireMember } from "./lib";
import { isLive } from "./runs";
import { jobFinished } from "../packages/contracts/src/compute";

const DEFAULT_AGENTS = [
  { harness: "claude", handle: "claude", model: "Fable 5.1", effort: "high" },
  { harness: "codex", handle: "codex", model: "GPT-5.6 Sol", effort: "medium" },
];

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const u = await me(ctx).catch(() => null);
    if (!u) return [];
    const rows = await ctx.db.query("members").withIndex("by_login", (q) => q.eq("githubLogin", u.githubLogin!)).collect();
    const ws = await Promise.all(rows.map((r) => ctx.db.get(r.workspaceId)));
    return ws.filter((w): w is NonNullable<typeof w> => !!w && !w.deletedAt).map((w) => ({ id: w._id, name: w.name, repos: w.repos }));
  },
});

export const detail = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const u = await requireMember(ctx, workspaceId);
    const w = await ctx.db.get(workspaceId);
    if (!w) return null;
    const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    return { id: w._id, name: w.name, repos: w.repos, members: members.map((m) => m.githubLogin), agents, canDelete: w.createdBy === u._id };
  },
});

/** Any member can rename the workspace. Double-click the name in the sidebar. */
export const rename = mutation({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  handler: async (ctx, { workspaceId, name }) => {
    await requireMember(ctx, workspaceId);
    const n = name.trim().slice(0, 48);
    if (!n) throw new Error("a workspace needs a name");
    await ctx.db.patch(workspaceId, { name: n });
    return n;
  },
});

/**
 * Only the person who created the workspace can delete it. Like deleting a chat, history and git
 * references are kept, but every chat is deleted, shared folders are revoked and all members lose access.
 */
export const remove = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const u = await requireMember(ctx, workspaceId);
    const w = await ctx.db.get(workspaceId);
    if (!w || w.deletedAt) throw new Error("This workspace has already been deleted.");
    if (w.createdBy !== u._id) throw new Error("Only the person who created this workspace can delete it.");
    const chats = (await ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).filter((c) => c.state !== "deleted");
    for (const c of chats) {
      const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", c._id)).collect();
      if (runs.some((r) => isLive(r.state))) throw new Error(`Stop the running agent in “${c.title}” before deleting this workspace.`);
      const jobs = await ctx.db.query("computeJobs").withIndex("by_chat", (q) => q.eq("chatId", c._id)).collect();
      if (jobs.some((j) => !jobFinished(j.state))) throw new Error(`Stop or cancel the jobs in “${c.title}” before deleting this workspace.`);
    }
    for (const c of chats) await ctx.db.patch(c._id, { state: "deleted" });
    for (const r of await ctx.db.query("workspaceResources").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect())
      if (!r.revoked) await ctx.db.patch(r._id, { revoked: true });
    for (const p of await ctx.db.query("presence").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()) await ctx.db.delete(p._id);
    for (const m of await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()) await ctx.db.delete(m._id);
    await ctx.db.patch(workspaceId, { deletedAt: Date.now() });
  },
});

export const create = mutation({
  args: { name: v.string(), repo: v.union(v.string(), v.null()) },
  handler: async (ctx, { name, repo }) => {
    const u = await me(ctx);
    const id = await ctx.db.insert("workspaces", { name, repos: repo ? [repo] : [], createdBy: u._id });
    await ctx.db.insert("members", { workspaceId: id, githubLogin: u.githubLogin!, invitedBy: u._id });
    for (const a of DEFAULT_AGENTS)
      await ctx.db.insert("agents", { workspaceId: id, ...a, permissionMode: "ask", alwaysAllow: ["git status", "git diff"], contextPolicy: "since-landing-plus-summary" });
    return id;
  },
});

export const addRepo = mutation({
  args: { workspaceId: v.id("workspaces"), repo: v.string() },
  handler: async (ctx, { workspaceId, repo }) => {
    await requireMember(ctx, workspaceId);
    const w = await ctx.db.get(workspaceId);
    if (w && !w.repos.includes(repo)) await ctx.db.patch(workspaceId, { repos: [...w.repos, repo] });
  },
});

/** Invite by GitHub login. Optionally also adds the person to a chat (the "add to the chat right away" preference). */
export const invite = mutation({
  args: { workspaceId: v.id("workspaces"), githubLogin: v.string(), chatId: v.union(v.id("chats"), v.null()) },
  handler: async (ctx, { workspaceId, githubLogin, chatId }) => {
    const u = await requireMember(ctx, workspaceId);
    const login = githubLogin.trim().replace(/^@/, "").toLowerCase();
    const existing = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    if (!existing.some((m) => m.githubLogin === login)) await ctx.db.insert("members", { workspaceId, githubLogin: login, invitedBy: u._id });
    if (chatId) {
      const chat = await ctx.db.get(chatId);
      if (chat && !chat.private && !chat.members.includes(login)) await ctx.db.patch(chatId, { members: [...chat.members, login] });
    }
    return login;
  },
});

export const updateAgent = mutation({
  args: { agentId: v.id("agents"), patch: v.object({ handle: v.optional(v.string()), model: v.optional(v.string()), effort: v.optional(v.string()), permissionMode: v.optional(v.string()), alwaysAllow: v.optional(v.array(v.string())), contextPolicy: v.optional(v.string()) }) },
  handler: async (ctx, { agentId, patch }) => {
    const a = await ctx.db.get(agentId);
    if (!a) return;
    await requireMember(ctx, a.workspaceId);
    await ctx.db.patch(agentId, patch);
  },
});

export const addAgent = mutation({
  args: { workspaceId: v.id("workspaces"), harness: v.string() },
  handler: async (ctx, { workspaceId, harness }) => {
    await requireMember(ctx, workspaceId);
    const existing = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    const n = existing.filter((a) => a.harness === harness).length;
    const models: Record<string, string> = { claude: "Fable 5.1", codex: "GPT-5.6 Sol", omp: "GPT-5.6 Sol" };
    return ctx.db.insert("agents", { workspaceId, harness, handle: n ? `${harness}${n + 1}` : harness, model: models[harness] ?? "", effort: "medium", permissionMode: "ask", alwaysAllow: ["git status", "git diff"], contextPolicy: "since-landing-plus-summary" });
  },
});

export const removeAgent = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const a = await ctx.db.get(agentId);
    if (!a) return;
    await requireMember(ctx, a.workspaceId);
    await ctx.db.delete(agentId);
  },
});
