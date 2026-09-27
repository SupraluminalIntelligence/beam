import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireLayer } from "../layers";
import { message, readableChat } from "./shape";

export const list = query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    await readableChat(ctx, chatId, login);
    return (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).map(message);
  },
});
