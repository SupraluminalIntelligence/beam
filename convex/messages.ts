import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { autoTitle, requireChat } from "./lib";

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
    let target = null as null | string;
    if (mentionHandle) {
      const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
      const a = agents.find((x) => x.handle === mentionHandle);
      if (!a) throw new Error(`no agent @${mentionHandle} in this workspace`);
      if (chat.agents && !chat.agents.includes(a._id)) throw new Error(`@${mentionHandle} is not in this chat`);
      target = a._id;
    } else if (chat.private && chat.pinnedAgent) target = chat.pinnedAgent;
    const live = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .filter((q) => q.or(q.eq(q.field("state"), "working"), q.eq(q.field("state"), "starting"), q.eq(q.field("state"), "queued"))).first();
    const kind = target ? (live ? "steer" : "dispatch") : "text";
    const patch: Record<string, unknown> = { lastMessageAt: Date.now() };
    if (chat.untitled) Object.assign(patch, { untitled: false, title: autoTitle(body) });
    await ctx.db.patch(chatId, patch);
    const id = await ctx.db.insert("messages", { chatId, author: u.githubLogin!, kind, text: body, runId: live?._id ?? null, reactions: [] });
    // TODO(M2): if kind === "dispatch" && chat.repo, insert a run for the dispatcher's online runner (or pinnedRunner)
    return { id, kind };
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
