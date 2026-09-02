import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { chatId: v.id("chats") },
  handler: (ctx, { chatId }) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
});

/** A plain message, a dispatch, or a steer. The kind is decided here, server-side, from chat state. */
export const send = mutation({
  args: { chatId: v.id("chats"), author: v.string(), text: v.string(), mention: v.union(v.string(), v.null()) },
  handler: async (ctx, { chatId, author, text, mention }) => {
    const chat = await ctx.db.get(chatId);
    if (!chat) throw new Error("no such chat");
    const live = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .filter((q) => q.or(q.eq(q.field("state"), "working"), q.eq(q.field("state"), "starting"))).first();
    const target = mention ?? (chat.private ? chat.pinnedAgent : null);
    const kind = target ? (live ? "steer" : "dispatch") : "text";
    if (chat.untitled) await ctx.db.patch(chatId, { untitled: false, title: autoTitle(text) });
    return ctx.db.insert("messages", { chatId, author, kind, text, runId: live?._id ?? null, reactions: [] });
    // TODO(M2): on "dispatch", insert a run assigned to the dispatcher's online runner (or pinnedRunner)
  },
});

export const react = mutation({
  args: { messageId: v.id("messages"), emoji: v.string(), userId: v.string() },
  handler: async (ctx, { messageId, emoji, userId }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return;
    const rx = m.reactions.map((r) => ({ ...r }));
    const r = rx.find((x) => x.emoji === emoji);
    if (!r) rx.push({ emoji, by: [userId] });
    else if (r.by.includes(userId)) r.by = r.by.filter((b) => b !== userId);
    else r.by.push(userId);
    await ctx.db.patch(messageId, { reactions: rx.filter((x) => x.by.length) });
  },
});

function autoTitle(text: string): string {
  const words = text.replace(/@\w+/g, "").replace(/`/g, "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return (words || "Untitled").replace(/[.,;:!?]+$/, "").toLowerCase();
}
