import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireLayer } from "../layers";
import { requireMemberLogin } from "../lib";
import { activityFor, visibleChats } from "../chats";
import { chat, readableChat } from "./shape";

export const list = query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireLayer(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    return (await visibleChats(ctx, workspaceId, login)).map(chat);
  },
});

export const get = query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    return chat(await readableChat(ctx, chatId, login));
  },
});

/** The same status squares the plain apps show, as this person sees them. */
export const activity = query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireLayer(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    return activityFor(ctx, workspaceId, login);
  },
});
