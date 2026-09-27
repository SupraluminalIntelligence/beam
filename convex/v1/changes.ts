import { v } from "convex/values";
import { requireLayer, v1Mutation, v1Query } from "../layers";
import { change, readableChat } from "./shape";

export const list = v1Query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    await readableChat(ctx, chatId, login);
    return (await ctx.db.query("changes").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).map(change);
  },
});
