import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, type ObjectType, type PropertyValidators } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export async function me(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const id = await getAuthUserId(ctx);
  if (!id) throw new Error("not signed in");
  const u = await ctx.db.get(id);
  if (!u || !u.githubLogin) throw new Error("no user");
  return u;
}

export async function requireMember(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const u = await me(ctx);
  await requireMemberLogin(ctx, workspaceId, u.githubLogin!);
  return u;
}

/** Membership by login, for callers that are not signed in with Convex Auth (layer tokens). */
export async function requireMemberLogin(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">, login: string) {
  const rows = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
  if (!rows.some((r) => r.githubLogin === login)) throw new Error("not a member");
}

export async function requireChat(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  const u = await me(ctx);
  const chat = await requireChatLogin(ctx, chatId, u.githubLogin!);
  return { chat, u };
}

/** What a person may see of a chat: workspace members see team chats, members of a private chat see it. */
export async function requireChatLogin(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">, login: string) {
  const chat = await ctx.db.get(chatId);
  if (!chat) throw new Error("no such chat");
  await requireMemberLogin(ctx, chat.workspaceId, login);
  if (chat.private && !chat.members.includes(login)) throw new Error("private chat");
  // Existing query subscriptions can finish while clients remove a deleted chat.
  // Mutations must never revive it (including messages, routing, and settings).
  if (chat.state === "deleted" && "scheduler" in ctx) throw new Error("This chat has been deleted.");
  return chat;
}

export function autoTitle(text: string): string {
  const words = text.replace(/@\w+/g, "").replace(/`/g, "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const t = (words || "Untitled").replace(/[.,;:!?]+$/, "");
  return t.length > 42 ? t.slice(0, 42).replace(/\s+\S*$/, "") : t;
}

/**
 * Production Convex tells a client only "Server Error" for a thrown Error; a ConvexError keeps its message.
 * Code other than the plain apps reads these: agents through the runner's tools, and Beam Worlds. They need
 * the reason ("Select this study explicitly before running it") to act on it instead of guessing.
 */
export function plainErrors<C, A, R>(handler: (ctx: C, args: A) => Promise<R>): (ctx: C, args: A) => Promise<R> {
  return async (ctx, args) => {
    try { return await handler(ctx, args); }
    catch (e) { throw e instanceof ConvexError ? e : new ConvexError(e instanceof Error ? e.message : String(e)); }
  };
}
/** A public query or mutation whose errors reach its caller as written: the runner, or a Beam World. */
export const readableQuery = <A extends PropertyValidators, R>(def: { args: A; handler: (ctx: QueryCtx, args: ObjectType<A>) => Promise<R> }) =>
  query({ args: def.args, handler: plainErrors(def.handler) });
export const readableMutation = <A extends PropertyValidators, R>(def: { args: A; handler: (ctx: MutationCtx, args: ObjectType<A>) => Promise<R> }) =>
  mutation({ args: def.args, handler: plainErrors(def.handler) });
