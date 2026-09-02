import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { autoTitle, requireChat } from "./lib";
import { chooseRunner, isLive } from "./runs";

export const list = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    await requireChat(ctx, chatId);
    return ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
  },
});

/** Kind is decided here from chat state: plain text, a dispatch, or a steer of the live run. */
export const send = mutation({
  args: { chatId: v.id("chats"), text: v.string(), mentionHandle: v.union(v.string(), v.null()) },
  handler: async (ctx, { chatId, text, mentionHandle }) => {
    const { chat, u } = await requireChat(ctx, chatId);
    const body = text.trim();
    if (!body) throw new Error("empty");
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    let target: typeof agents[number] | null = null;
    if (mentionHandle) {
      const a = agents.find((x) => x.handle === mentionHandle);
      if (!a) throw new Error(`no agent @${mentionHandle} in this workspace`);
      if (chat.agents && !chat.agents.includes(a._id)) throw new Error(`@${mentionHandle} is not in this chat`);
      target = a;
    } else if (chat.private && chat.pinnedAgent) target = agents.find((x) => x._id === chat.pinnedAgent) ?? null;
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    const live = runs.find((r) => isLive(r.state)) ?? null;
    // A mention of a different agent while one is live is a plain message: one active run per chat.
    const steer = !!(target && live && live.agentId === target._id);
    const kind = target ? (live ? (steer ? "steer" : "text") : "dispatch") : "text";
    const runner = kind === "dispatch" ? await chooseRunner(ctx, chat, u.githubLogin!, target!.harness) : null;
    const patch: Record<string, unknown> = { lastMessageAt: Date.now() };
    if (chat.untitled) Object.assign(patch, { untitled: false, title: autoTitle(body) });
    await ctx.db.patch(chatId, patch);
    const id = await ctx.db.insert("messages", { chatId, author: u.githubLogin!, kind, text: body, runId: live?._id ?? null, reactions: [] });
    if (runner) {
      const runId = await ctx.db.insert("runs", {
        chatId, agentId: target!._id, runnerId: runner._id, dispatchedBy: u.githubLogin!, dispatchMessageId: id, state: "queued",
        branch: chat.activeBranch, worktree: null, resumeCursor: null, landing: null, startedAt: null, endedAt: null,
      });
      await ctx.db.patch(id, { runId });
    }
    return { id, kind, runner: runner?.name ?? null };
  },
});

export const react = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, { messageId, emoji }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return;
    const { u } = await requireChat(ctx, m.chatId);
    const login = u.githubLogin!;
    const rx = m.reactions.map((r) => ({ emoji: r.emoji, by: [...r.by] }));
    const r = rx.find((x) => x.emoji === emoji);
    if (!r) rx.push({ emoji, by: [login] });
    else if (r.by.includes(login)) r.by = r.by.filter((b) => b !== login);
    else r.by.push(login);
    await ctx.db.patch(messageId, { reactions: rx.filter((x) => x.by.length) });
  },
});
