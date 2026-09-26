import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { mentionTargets } from "./mentionTargets";
import { me, requireChat } from "./lib";
import { schedulePush } from "./push";

export const defaults = { enabled: true, completed: true, failed: true, input: true, mention: true, sound: true };
const preferenceShape = v.object({ enabled: v.boolean(), completed: v.boolean(), failed: v.boolean(), input: v.boolean(), mention: v.optional(v.boolean()), sound: v.boolean() });
export const preferences = query({ args: {}, handler: async (ctx) => ({ ...defaults, ...(await me(ctx)).notificationPreferences }) });
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
    const prefs = { ...defaults, ...user?.notificationPreferences };
    if (!prefs.enabled || !prefs[kind]) continue;
    const key = `${runId}:${eventKey}`;
    if (await ctx.db.query("notifications").withIndex("by_key", (q) => q.eq("recipient", recipient).eq("key", key)).first()) continue;
    const id = await ctx.db.insert("notifications", { recipient, key, chatId: chat._id, workspaceId: chat.workspaceId, runId, kind,
      title: `${label} ${kind === "completed" ? "finished" : kind === "failed" ? "couldn’t finish" : "needs your input"}`,
      body: chat.title.slice(0, 140), readAt: null, deliveredAt: null });
    await schedulePush(ctx, id);
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
  if (!row || row.recipient !== user.githubLogin || row.deliveredAt !== null || row.readAt !== null || (row.deliveryExpiresAt ?? 0) > Date.now()) return false;
  await requireChat(ctx, row.chatId);
  const prefs = { ...defaults, ...user.notificationPreferences };
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

/** Mentions always leave an inbox record; preferences/mute only suppress desktop delivery. */
export async function notifyMentions(ctx: MutationCtx, messageId: Id<"messages">) {
  const message = await ctx.db.get(messageId);
  if (!message || !message.text.includes("@") || message.author.startsWith("agent:")) return;
  const chat = await ctx.db.get(message.chatId);
  if (!chat || chat.state === "deleted") return;
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  const people = [];
  for (const member of members) {
    if (chat.private && !chat.members.includes(member.githubLogin)) continue;
    const user = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", member.githubLogin)).first();
    if (user) people.push({ login: member.githubLogin, name: user.name, username: user.username });
  }
  const agents = await ctx.db.query("agents").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect();
  const sender = people.find(p => p.login === message.author)?.username ?? message.author;
  for (const recipient of mentionTargets(message.text, people, agents.map(a => a.handle))) {
    if (recipient === message.author) continue;
    const key = `${messageId}:mention`;
    if (await ctx.db.query("notifications").withIndex("by_key", q => q.eq("recipient", recipient).eq("key", key)).first()) continue;
    const id = await ctx.db.insert("notifications", { recipient, key, chatId: chat._id, workspaceId: chat.workspaceId, messageId, kind: "mention", title: `${sender} mentioned you`.slice(0, 200), body: `${chat.title}: ${message.text}`.slice(0, 500), readAt: null, deliveredAt: null });
    await schedulePush(ctx, id);
  }
}

/** A short lease prevents competing desktops from sending the same alert. */
export const reserve = mutation({ args: { id: v.id("notifications"), token: v.string() }, handler: async (ctx, { id, token }) => {
  if (!token || token.length > 100) throw new Error("Invalid delivery token");
  const user = await me(ctx), row = await ctx.db.get(id);
  if (!row || row.recipient !== user.githubLogin || row.readAt !== null || row.deliveredAt !== null || (row.deliveryExpiresAt ?? 0) > Date.now() || Date.now() - row._creationTime > 10 * 60_000) return false;
  await requireChat(ctx, row.chatId);
  const prefs = { ...defaults, ...user.notificationPreferences };
  if (!prefs.enabled || !prefs[row.kind] || (await subscription(ctx, row.chatId, user.githubLogin!))?.muted) return false;
  await ctx.db.patch(id, { deliveryToken: token, deliveryExpiresAt: Date.now() + 30_000 });
  return true;
} });
export const finishDelivery = mutation({ args: { id: v.id("notifications"), token: v.string(), accepted: v.boolean() }, handler: async (ctx, { id, token, accepted }) => {
  const user = await me(ctx), row = await ctx.db.get(id);
  if (!row || row.recipient !== user.githubLogin) throw new Error("Not your notification");
  await requireChat(ctx, row.chatId);
  if (row.deliveryToken !== token) return;
  await ctx.db.patch(id, { deliveryToken: undefined, deliveryExpiresAt: undefined, ...(accepted && row.deliveredAt === null ? { deliveredAt: Date.now() } : {}) });
} });
