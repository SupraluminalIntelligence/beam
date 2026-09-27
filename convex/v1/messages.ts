import { v } from "convex/values";
import { sendAs, toggleReaction } from "../messages";
import { firstMention } from "../../packages/contracts/src/mentions";
import { requireLayer, v1Mutation, v1Query } from "../layers";
import { message, readableChat } from "./shape";

export const list = v1Query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    await readableChat(ctx, chatId, login);
    return (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).map(message);
  },
});

/**
 * Post as the token's person. The first `@handle` of an agent in the chat starts it, or joins the live run it
 * already has for you, exactly as in the composer. Runs go to the person's own default machine and account.
 */
export const send = v1Mutation({
  args: { token: v.string(), chatId: v.id("chats"), text: v.string(), mention: v.optional(v.union(v.string(), v.null())), runId: v.optional(v.union(v.id("runs"), v.null())) },
  handler: async (ctx, { token, chatId, text, mention, runId }) => {
    const { login } = await requireLayer(ctx, token, "chat:write");
    const chat = await readableChat(ctx, chatId, login);
    if (text.length > 20_000) throw new Error("message too long");
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    const handles = new Set(agents.filter((a) => !chat.agents || chat.agents.includes(a._id)).map((a) => a.handle));
    const mentionHandle = mention ? mention.replace(/^@/, "").toLowerCase() : firstMention(text, handles);
    try {
      return await sendAs(ctx, chat, login, { chatId, text, mentionHandle, ...(runId ? { targetRunId: runId } : {}) });
    } catch (e) {
      // A layer has no local runner, like the phone: a dispatch goes to the person's chosen default account.
      if (/^Choose a connection/.test((e as Error).message)) throw new Error(`Choose a default account for @${mentionHandle} in Beam (Settings → Models & accounts); apps use it to start agents.`);
      throw e;
    }
  },
});

export const react = v1Mutation({
  args: { token: v.string(), messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, { token, messageId, emoji }) => {
    const { login } = await requireLayer(ctx, token, "chat:write");
    const m = await ctx.db.get(messageId);
    if (!m) throw new Error("no such message");
    await readableChat(ctx, m.chatId, login);
    if (!emoji.trim() || emoji.length > 32) throw new Error("an emoji is one short string");
    await toggleReaction(ctx, m, login, emoji);
    return null;
  },
});
