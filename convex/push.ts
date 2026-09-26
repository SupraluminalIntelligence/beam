import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { me } from "./lib";
import { defaults } from "./notifications";

/**
 * Push to phones. Every inbox row schedules one send; the phone app registers its Expo push token after
 * sign-in. Expo's push service relays to APNs, so Beam never holds an Apple key at runtime.
 */

const TOKEN = /^Expo(nent)?PushToken\[[^\]]{8,}\]$/;
export const isPushToken = (token: string) => TOKEN.test(token);

export const register = mutation({
  args: { token: v.string(), platform: v.string(), deviceName: v.union(v.string(), v.null()) },
  handler: async (ctx, { token, platform, deviceName }) => {
    const u = await me(ctx);
    if (!isPushToken(token)) throw new Error("Not an Expo push token");
    const row = await ctx.db.query("pushTokens").withIndex("by_token", (q) => q.eq("token", token)).first();
    const value = { login: u.githubLogin!, token, platform: platform.slice(0, 20), deviceName: deviceName?.slice(0, 80) ?? null, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("pushTokens", value);
  },
});

/** Signing out on a phone stops its pushes. Only the signed-in owner can remove a token. */
export const unregister = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const u = await me(ctx);
    const row = await ctx.db.query("pushTokens").withIndex("by_token", (q) => q.eq("token", token)).first();
    if (row && row.login === u.githubLogin) await ctx.db.delete(row._id);
  },
});

/** Called wherever an inbox row is created. Test contexts have no scheduler. */
export async function schedulePush(ctx: MutationCtx, notificationId: Id<"notifications">) {
  await ctx.scheduler?.runAfter(0, internal.push.send, { notificationId });
}

export type PushMessage = { to: string; title: string; body: string; sound: "default" | null; threadId: string; data: { notificationId: string; chatId: string; workspaceId: string; messageId: string | null; kind: string } };

/**
 * Pure: who gets what for one inbox row. Nothing when the row is read, the kind is switched off, the chat is
 * muted, or the person is looking at that chat right now on another device.
 */
export function pushMessages(n: Pick<Doc<"notifications">, "_id" | "kind" | "title" | "body" | "chatId" | "workspaceId" | "messageId" | "readAt">, tokens: string[], prefs: Partial<typeof defaults> | undefined, opts: { muted: boolean; focusedHere: boolean }): PushMessage[] {
  const p = { ...defaults, ...prefs };
  if (n.readAt !== null || !p.enabled || p[n.kind] === false || opts.muted || opts.focusedHere) return [];
  return tokens.map((to) => ({
    to, title: n.title.slice(0, 120), body: n.body.slice(0, 240), sound: p.sound ? "default" : null, threadId: String(n.chatId),
    data: { notificationId: String(n._id), chatId: String(n.chatId), workspaceId: String(n.workspaceId), messageId: n.messageId ? String(n.messageId) : null, kind: n.kind },
  }));
}

export const forNotification = internalQuery({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const n = await ctx.db.get(notificationId);
    if (!n) return [];
    const user = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", n.recipient)).first();
    const tokens = (await ctx.db.query("pushTokens").withIndex("by_login", (q) => q.eq("login", n.recipient)).collect()).map((t) => t.token);
    const follow = (await ctx.db.query("chatFollowers").withIndex("by_chat", (q) => q.eq("chatId", n.chatId)).collect()).find((f) => f.login === n.recipient);
    const presence = await ctx.db.query("presence").withIndex("by_login", (q) => q.eq("githubLogin", n.recipient)).collect();
    const focusedHere = presence.some((p) => p.focusedChat === n.chatId && p.updatedAt > Date.now() - 60_000);
    return pushMessages(n, tokens, user?.notificationPreferences, { muted: !!follow?.muted, focusedHere });
  },
});

export const forget = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, { tokens }) => {
    for (const token of tokens) {
      const row = await ctx.db.query("pushTokens").withIndex("by_token", (q) => q.eq("token", token)).first();
      if (row) await ctx.db.delete(row._id);
    }
  },
});

/** Tokens Expo says are dead: the app was deleted or notifications were revoked. */
export function deadTokens(messages: { to: string }[], tickets: { status: string; details?: { error?: string } }[]): string[] {
  return tickets.flatMap((t, i) => (t.status === "error" && t.details?.error === "DeviceNotRegistered" && messages[i] ? [messages[i]!.to] : []));
}

export const send = internalAction({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const messages: PushMessage[] = await ctx.runQuery(internal.push.forNotification, { notificationId });
    if (!messages.length) return;
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(process.env["EXPO_ACCESS_TOKEN"] ? { authorization: `Bearer ${process.env["EXPO_ACCESS_TOKEN"]}` } : {}) },
      body: JSON.stringify(messages),
    });
    if (!res.ok) { console.warn(`push: Expo returned ${res.status}`); return; }
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const dead = deadTokens(messages, json.data ?? []);
    if (dead.length) await ctx.runMutation(internal.push.forget, { tokens: dead });
  },
});

declare const process: { env: Record<string, string | undefined> };
