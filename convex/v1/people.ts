import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { LAYER_ID } from "../../packages/contracts/src/layer";
import { requireLayer } from "../layers";
import { requireMemberLogin } from "../lib";
import { focusAs, presenceIn, typingIn } from "../presence";
import { readableChat } from "./shape";

/** The shared truth of where people are. A chat focused in a private chat you are not in reads as nowhere. */
export const presence = query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireLayer(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    const rows = await presenceIn(ctx, workspaceId);
    const out = [];
    for (const r of rows) {
      const c = r.chatId ? await ctx.db.get(r.chatId) : null;
      const visible = !!c && c.state !== "deleted" && (!c.private || c.members.includes(login));
      out.push({ login: r.login, chatId: visible ? r.chatId : null, layer: r.layer });
    }
    return out;
  },
});

export const typing = query({
  args: { token: v.string(), chatId: v.id("chats") },
  handler: async (ctx, { token, chatId }) => {
    const { login } = await requireLayer(ctx, token);
    const chat = await readableChat(ctx, chatId, login);
    return (await typingIn(ctx, chat)).map((t) => ({ login: t.login, until: t.expiresAt }));
  },
});

/** Say which chat you are in, from which layer. Every interface shares this one truth; the last to write wins. */
export const focus = mutation({
  args: { token: v.string(), workspaceId: v.id("workspaces"), chatId: v.optional(v.union(v.id("chats"), v.null())), layer: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { token, workspaceId, chatId, layer }) => {
    const { login } = await requireLayer(ctx, token, "presence:write");
    await requireMemberLogin(ctx, workspaceId, login);
    if (chatId && (await readableChat(ctx, chatId, login)).workspaceId !== workspaceId) throw new Error("that chat is in another workspace");
    if (layer && !LAYER_ID.test(layer)) throw new Error("a layer id is lowercase letters, digits and dashes, up to 40");
    await focusAs(ctx, workspaceId, login, chatId ?? null, layer ?? undefined);
    return null;
  },
});
