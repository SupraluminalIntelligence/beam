import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
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
  const rows = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
  if (!rows.some((r) => r.githubLogin === u.githubLogin)) throw new Error("not a member");
  return u;
}

export async function requireChat(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  const chat = await ctx.db.get(chatId);
  if (!chat) throw new Error("no such chat");
  const u = await requireMember(ctx, chat.workspaceId);
  if (chat.private && !chat.members.includes(u.githubLogin!)) throw new Error("private chat");
  return { chat, u };
}

export function autoTitle(text: string): string {
  const words = text.replace(/@\w+/g, "").replace(/`/g, "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const t = (words || "Untitled").replace(/[.,;:!?]+$/, "");
  return t.length > 42 ? t.slice(0, 42).replace(/\s+\S*$/, "") : t;
}
