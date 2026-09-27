import { v } from "convex/values";
import { WORLD_ID } from "../../packages/contracts/src/worlds";
import { requireApp, v1Mutation, v1Query } from "../layers";
import { requireMemberLogin } from "../lib";
import { focusAs, presenceIn, typingIn } from "../presence";
import { readableChat } from "./shape";

/** The shared truth of where people are. A chat focused in a private chat you are not in reads as nowhere. */
export const presence = v1Query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireApp(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    const rows = await presenceIn(ctx, workspaceId);
    const out = [];
    for (const r of rows) {
      const c = r.chatId ? await ctx.db.get(r.chatId) : null;
      const visible = !!c && c.state !== "deleted" && (!c.private || c.members.includes(login));
      out.push({ login: r.login, chatId: visible ? r.chatId : null, world: r.world });
    }
    return out;
  },
});

export const typing = v1Query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireApp(ctx, token);
    const chat = await readableChat(ctx, chatId, login);
    return (await typingIn(ctx, chat)).map((t) => ({ login: t.login, until: t.expiresAt }));
  },
});

/** Say which chat you are in, from which world. Every interface shares this one truth; the last to write wins. */
export const focus = v1Mutation({
  args: { token: v.string(), workspaceId: v.id("workspaces"), chatId: v.optional(v.union(v.id("chats"), v.null())), world: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { token, workspaceId, chatId, world }) => {
    const { login } = await requireApp(ctx, token, "presence:write");
    await requireMemberLogin(ctx, workspaceId, login);
    if (chatId && (await readableChat(ctx, chatId, login)).workspaceId !== workspaceId) throw new Error("that chat is in another workspace");
    if (world && !WORLD_ID.test(world)) throw new Error("a world id is lowercase letters, digits and dashes, up to 40");
    await focusAs(ctx, workspaceId, login, chatId ?? null, world ?? undefined);
    return null;
  },
});
