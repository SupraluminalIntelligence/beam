import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { me, requireMember, requireChat } from "./lib";

/** Which chat each person has focused. One chat per person. Client throttles writes. */
export const focus = mutation({
  args: { workspaceId: v.id("workspaces"), chatId: v.union(v.id("chats"), v.null()) },
  handler: async (ctx, { workspaceId, chatId }) => {
    const u = await requireMember(ctx, workspaceId);
    await focusAs(ctx, workspaceId, u.githubLogin!, chatId);
  },
});

/** One focused chat per person, whichever interface set it last. `layer` names that interface; the plain apps clear it. */
export async function focusAs(ctx: MutationCtx, workspaceId: Id<"workspaces">, login: string, chatId: Id<"chats"> | null, layer?: string) {
  const row = await ctx.db.query("presence").withIndex("by_login", (q) => q.eq("githubLogin", login)).first();
  if (row) await ctx.db.patch(row._id, { workspaceId, focusedChat: chatId, updatedAt: Date.now(), layer });
  else await ctx.db.insert("presence", { workspaceId, githubLogin: login, focusedChat: chatId, updatedAt: Date.now(), ...(layer ? { layer } : {}) });
}

export const inWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    return presenceIn(ctx, workspaceId);
  },
});

/** Who was here in the last two minutes and where. Membership is the caller's to check. */
export async function presenceIn(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const cutoff = Date.now() - 2 * 60_000;
  const rows = await ctx.db.query("presence").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
  return rows.filter((r) => r.updatedAt > cutoff).map((r) => ({ login: r.githubLogin, chatId: r.focusedChat, layer: r.layer ?? null }));
}

export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const u = await me(ctx).catch(() => null);
    if (!u) return;
    const row = await ctx.db.query("presence").withIndex("by_login", (q) => q.eq("githubLogin", u.githubLogin!)).first();
    if (row) await ctx.db.patch(row._id, { focusedChat: null, updatedAt: 0 });
  },
});

/** Only activity is sent; draft text never leaves the composer. Sessions isolate multiple devices. */
export const setTyping = mutation({
  args: { chatId: v.id("chats"), session: v.string(), active: v.boolean() },
  handler: async (ctx, { chatId, session, active }) => {
    const { u } = await requireChat(ctx, chatId);
    if (session.length > 100) throw new Error("Invalid typing session");
    const row = await ctx.db.query("typing").withIndex("by_session", (q) => q.eq("chatId", chatId).eq("login", u.githubLogin!).eq("session", session)).first();
    if (!active) { if (row) await ctx.db.delete(row._id); return; }
    const expiresAt = Date.now() + 5000;
    if (row) await ctx.db.patch(row._id, { expiresAt });
    else await ctx.db.insert("typing", { chatId, login: u.githubLogin!, session, expiresAt });
  },
});
export const typingInChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { chat } = await requireChat(ctx, chatId);
    return typingIn(ctx, chat);
  },
});

/** Typing in a chat, from people who can still see it. Access is the caller's to check. */
export async function typingIn(ctx: QueryCtx, chat: Doc<"chats">) {
  const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
  const allowed = new Set(members.map((m) => m.githubLogin));
  const rows = await ctx.db.query("typing").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect();
  return rows.filter((r) => allowed.has(r.login) && (!chat.private || chat.members.includes(r.login))).map((r) => ({ login: r.login, expiresAt: r.expiresAt }));
}
export const cleanTyping = internalMutation({ args: {}, handler: async (ctx) => {
  const stale = await ctx.db.query("typing").filter((q) => q.lt(q.field("expiresAt"), Date.now() - 60_000)).take(500);
  for (const row of stale) await ctx.db.delete(row._id);
} });
