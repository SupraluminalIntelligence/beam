import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChat } from "./lib";
import { runnerForToken } from "./runners";

export const threadRepos = (chat: Doc<"chats">) => chat.repos ?? (chat.repo ? [chat.repo] : []);

/** The open change for a repo in a thread, if any. One open change per repo per thread. */
export async function openChange(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">, repo: string) {
  const rows = await ctx.db.query("changes").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
  return rows.find((c) => c.repo === repo && c.state === "open") ?? null;
}

/** Everyone in the thread sees its changes: header chips, landing cards, the done suggestion. */
export const forChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    await requireChat(ctx, chatId);
    return ctx.db.query("changes").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
  },
});

/** Runner side: what branch to check out per repo before a run. */
export const openForRun = query({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const runner = await runnerForToken(ctx, token);
    const run = await ctx.db.get(runId);
    if (!run || run.runnerId !== runner._id) throw new Error("not this runner's run");
    const rows = await ctx.db.query("changes").withIndex("by_chat", (q) => q.eq("chatId", run.chatId)).collect();
    return rows;
  },
});

/** Runner side: a run landed work in a repo. Creates the change on first landing, updates it after. */
export const land = mutation({
  args: {
    token: v.string(), runId: v.id("runs"), repo: v.string(), branch: v.string(), base: v.string(), title: v.string(),
    add: v.number(), del: v.number(), files: v.number(), prUrl: v.union(v.string(), v.null()), prNumber: v.union(v.number(), v.null()),
  },
  handler: async (ctx, a) => {
    const runner = await runnerForToken(ctx, a.token);
    const run = await ctx.db.get(a.runId);
    if (!run || run.runnerId !== runner._id) throw new Error("not this runner's run");
    const chat = (await ctx.db.get(run.chatId))!;
    const existing = await openChange(ctx, chat._id, a.repo);
    if (existing && existing.branch === a.branch) {
      await ctx.db.patch(existing._id, { add: a.add, del: a.del, files: a.files, prUrl: a.prUrl ?? existing.prUrl, prNumber: a.prNumber ?? existing.prNumber, updatedAt: Date.now() });
      return existing._id;
    }
    return ctx.db.insert("changes", {
      chatId: chat._id, workspaceId: chat.workspaceId, repo: a.repo, branch: a.branch, base: a.base, state: "open", title: a.title,
      prUrl: a.prUrl, prNumber: a.prNumber, add: a.add, del: a.del, files: a.files, adopted: false, createdBy: run.dispatchedBy, updatedAt: Date.now(), resolvedAt: null,
    });
  },
});

/** Runner side: the thread adopts an existing PR (review it, continue it). */
export const adopt = mutation({
  args: { token: v.string(), runId: v.id("runs"), repo: v.string(), branch: v.string(), base: v.string(), title: v.string(), prUrl: v.string(), prNumber: v.number() },
  handler: async (ctx, a) => {
    const runner = await runnerForToken(ctx, a.token);
    const run = await ctx.db.get(a.runId);
    if (!run || run.runnerId !== runner._id) throw new Error("not this runner's run");
    const chat = (await ctx.db.get(run.chatId))!;
    const existing = await openChange(ctx, chat._id, a.repo);
    if (existing) throw new Error(`this thread already has an open change on ${a.repo} (${existing.branch}); land or close that first`);
    if (!threadRepos(chat).includes(a.repo)) await ctx.db.patch(chat._id, { repos: [...threadRepos(chat), a.repo] });
    return ctx.db.insert("changes", {
      chatId: chat._id, workspaceId: chat.workspaceId, repo: a.repo, branch: a.branch, base: a.base, state: "open", title: a.title,
      prUrl: a.prUrl, prNumber: a.prNumber, add: 0, del: 0, files: 0, adopted: true, createdBy: run.dispatchedBy, updatedAt: Date.now(), resolvedAt: null,
    });
  },
});

/** Runner side: the agent asked for a fresh PR on a repo; the open change is closed out so the next landing starts a new branch. */
export const rotate = mutation({
  args: { token: v.string(), runId: v.id("runs"), repo: v.string() },
  handler: async (ctx, { token, runId, repo }) => {
    const runner = await runnerForToken(ctx, token);
    const run = await ctx.db.get(runId);
    if (!run || run.runnerId !== runner._id) throw new Error("not this runner's run");
    const existing = await openChange(ctx, run.chatId, repo);
    if (existing) await ctx.db.patch(existing._id, { state: "closed", resolvedAt: Date.now() });
    return existing?.branch ?? null;
  },
});

/** A person resolves a change by hand (merged elsewhere, abandoned). The cron does this automatically for PRs. */
export const resolve = mutation({
  args: { changeId: v.id("changes"), state: v.string() },
  handler: async (ctx, { changeId, state }) => {
    const c = await ctx.db.get(changeId);
    if (!c) throw new Error("no such change");
    await requireChat(ctx, c.chatId);
    await ctx.db.patch(changeId, { state, resolvedAt: Date.now() });
  },
});
