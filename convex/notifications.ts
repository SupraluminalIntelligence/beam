import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { me, requireChat } from "./lib";

export const defaults = { enabled: true, completed: true, failed: true, input: true, sound: true };
const preferenceShape = v.object({ enabled: v.boolean(), completed: v.boolean(), failed: v.boolean(), input: v.boolean(), sound: v.boolean() });
export const preferences = query({ args: {}, handler: async (ctx) => (await me(ctx)).notificationPreferences ?? defaults });
export const setPreferences = mutation({ args: { preferences: preferenceShape }, handler: async (ctx, args) => { const user = await me(ctx); await ctx.db.patch(user._id, { notificationPreferences: args.preferences }); } });

async function subscription(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">, login: string) {
  return (await ctx.db.query("chatFollowers").withIndex("by_chat", q => q.eq("chatId", chatId)).collect()).find(f => f.login === login);
}

/** Participation subscribes once; an explicit mute survives subsequent participation. */
export async function followParticipant(ctx: MutationCtx, chatId: Id<"chats">, login: string) {
  if (!await subscription(ctx, chatId, login)) await ctx.db.insert("chatFollowers", { chatId, login });
}

/** Durable, idempotent records, routed to the requester and participating teammates. */
export async function notifyRun(ctx: MutationCtx, runId: Id<"runs">, kind: "completed" | "failed" | "input", eventKey: string) {
  const run = await ctx.db.get(runId);
  if (!run) return;
  const chat = await ctx.db.get(run.chatId);
  if (!chat || chat.state === "deleted") return;
  const agent = await ctx.db.get(run.agentId);
  const followers = await ctx.db.query("chatFollowers").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect();
  const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
  const allowed = new Set(members.map((m) => m.githubLogin));
  const label = agent?.harness === "codex" ? "Codex" : agent?.harness === "claude" ? "Claude Code" : agent?.handle ?? "Agent";
  for (const recipient of new Set([run.dispatchedBy, ...followers.map((f) => f.login)])) {
    if (followers.some(f => f.login === recipient && f.muted)) continue;
    if (!allowed.has(recipient) || (chat.private && !chat.members.includes(recipient))) continue;
    const user = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", recipient)).first();
    const prefs = user?.notificationPreferences ?? defaults;
    if (!prefs.enabled || !prefs[kind]) continue;
    const key = `${runId}:${eventKey}`;
    if (await ctx.db.query("notifications").withIndex("by_key", (q) => q.eq("recipient", recipient).eq("key", key)).first()) continue;
    await ctx.db.insert("notifications", { recipient, key, chatId: chat._id, workspaceId: chat.workspaceId, runId, kind,
      title: `${label} ${kind === "completed" ? "finished" : kind === "failed" ? "couldn’t finish" : "needs your input"}`,
      body: chat.title.slice(0, 140), readAt: null, deliveredAt: null });
  }
}
export async function resolveInputNotifications(ctx: MutationCtx, runId: Id<"runs">, requestId?: string) {
  const rows = await ctx.db.query("notifications").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
  for (const row of rows) if (row.kind === "input" && row.readAt === null && (!requestId || row.key === `${runId}:input:${requestId}`)) await ctx.db.patch(row._id, { readAt: Date.now(), deliveredAt: row.deliveredAt ?? Date.now() });
}
export const inbox = query({ args: {}, handler: async (ctx) => {
  const user = await me(ctx);
  const rows = await ctx.db.query("notifications").withIndex("by_recipient", (q) => q.eq("recipient", user.githubLogin!)).order("desc").take(100);
  const visible = [];
  for (const row of rows) { try { const { chat } = await requireChat(ctx, row.chatId); if (chat.state !== "deleted") visible.push(row); } catch { /* Membership revoked. */ } }
  return visible;
} });
export const read = mutation({ args: { id: v.id("notifications") }, handler: async (ctx, { id }) => {
  const user = await me(ctx), row = await ctx.db.get(id);
  if (!row || row.recipient !== user.githubLogin) throw new Error("Not your notification");
  await requireChat(ctx, row.chatId);
  await ctx.db.patch(id, { readAt: Date.now(), deliveredAt: row.deliveredAt ?? Date.now() });
} });
/** One connected desktop claims the banner; the unread inbox remains available on all devices. */
export const claim = mutation({ args: { id: v.id("notifications") }, handler: async (ctx, { id }) => {
  const user = await me(ctx), row = await ctx.db.get(id);
  if (!row || row.recipient !== user.githubLogin || row.deliveredAt !== null || row.readAt !== null) return false;
  await requireChat(ctx, row.chatId);
  const prefs = user.notificationPreferences ?? defaults;
  if (!prefs.enabled || !prefs[row.kind] || (await subscription(ctx, row.chatId, user.githubLogin!))?.muted) return false;
  await ctx.db.patch(id, { deliveredAt: Date.now() });
  return true;
} });
export const muted = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  const { u } = await requireChat(ctx, chatId);
  return !!(await subscription(ctx, chatId, u.githubLogin!))?.muted;
} });
export const setMuted = mutation({ args: { chatId: v.id("chats"), muted: v.boolean() }, handler: async (ctx, { chatId, muted }) => {
  const { u } = await requireChat(ctx, chatId);
  const row = await subscription(ctx, chatId, u.githubLogin!);
  if (row) await ctx.db.patch(row._id, { muted });
  else await ctx.db.insert("chatFollowers", { chatId, login: u.githubLogin!, muted });
} });
// Keep older desktop clients compatible while they still show the composer toggle.
export const following = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  const { u } = await requireChat(ctx, chatId);
  const row = await subscription(ctx, chatId, u.githubLogin!);
  return !!row && !row.muted;
} });
export const follow = mutation({ args: { chatId: v.id("chats"), enabled: v.boolean() }, handler: async (ctx, { chatId, enabled }) => {
  const { u } = await requireChat(ctx, chatId);
  const row = await subscription(ctx, chatId, u.githubLogin!);
  if (row) await ctx.db.patch(row._id, { muted: !enabled });
  else await ctx.db.insert("chatFollowers", { chatId, login: u.githubLogin!, muted: !enabled });
} });
