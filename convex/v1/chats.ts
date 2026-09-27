import { v } from "convex/values";
import { requireApp, v1Mutation, v1Query } from "../layers";
import { requireMemberLogin } from "../lib";
import { activityFor, visibleChats } from "../chats";
import { chat, readableChat } from "./shape";

export const list = v1Query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireApp(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    return (await visibleChats(ctx, workspaceId, login)).map(chat);
  },
});

export const get = v1Query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireApp(ctx, token);
    return chat(await readableChat(ctx, chatId, login));
  },
});

/** The same status squares the plain apps show, as this person sees them. */
export const activity = v1Query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireApp(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    return activityFor(ctx, workspaceId, login);
  },
});
