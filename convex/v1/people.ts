import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireLayer } from "../layers";
import { requireMemberLogin } from "../lib";
import { presenceIn, typingIn } from "../presence";
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
      out.push({ login: r.login, chatId: visible ? r.chatId : null });
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
