import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { me, requireChat } from "./lib";
import { connectionStatuses, resolveConnection } from "../packages/contracts/src/connections";

export async function availableConnections(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">, login: string) {
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).collect();
  if (!members.some(m => m.githubLogin === login)) throw new Error("You are no longer a workspace member");
  const runners = (await Promise.all(members.map(m => ctx.db.query("runners").withIndex("by_owner", q => q.eq("ownerLogin", m.githubLogin)).collect()))).flat();
  return { members: members.map(m => m.githubLogin), runners };
}

export async function resolveForChat(ctx: QueryCtx | MutationCtx, chat: Doc<"chats">, login: string, harness: string, localRunnerId?: Id<"runners">) {
  const user = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", login)).first();
  const available = await availableConnections(ctx, chat.workspaceId, login);
  const override = user?.chatConnections?.find(p => p.chatId === chat._id && p.harness === harness);
  const global = user?.accountPreferences?.find(p => p.harness === harness);
  const legacy = user?.agentPreferences?.find(p => p.harness === harness);
  const pref = override ?? global ?? legacy;
  const choice = pref?.runnerId ? { runnerId: pref.runnerId, connectionId: pref.connectionId ?? "default" } : undefined;
  const selected = resolveConnection(available.runners, { login, harness, localRunnerId, choice, members: available.members, now: Date.now() });
  // Legacy runners ignore workScope and would put concurrent agents in the same checkout.
  // Profile-aware reports are emitted by the runner release that implements isolated workspaces.
  if (!Array.isArray(selected.runner.harnesses) || !selected.runner.harnesses.some(s => s && s.harness === harness && s.connectionId === selected.status.connectionId)) {
    throw new Error(`Update and restart Beam on ${selected.runner.displayName ?? selected.runner.name} to use account connections and isolated agent workspaces.`);
  }
  return { ...selected, source: override ? "chat" : global?.runnerId || (!global && legacy?.runnerId) ? "global" : "local" };
}

export function selectionKey(runnerId: string, status: { connectionId: string; email?: string | null | undefined; plan?: string | null | undefined; accountIdentity?: string | undefined }) {
  return JSON.stringify([runnerId, status.connectionId, status.email ?? null, status.plan ?? null, status.accountIdentity ?? null]);
}

export const preview = query({
  args: { chatId: v.id("chats"), harness: v.string(), localRunnerId: v.optional(v.id("runners")) },
  handler: async (ctx, { chatId, harness, localRunnerId }) => {
    const { chat, u } = await requireChat(ctx, chatId);
    const override = u.chatConnections?.find(p => p.chatId === chatId && p.harness === harness) ?? null;
    const available = await availableConnections(ctx, chat.workspaceId, u.githubLogin!);
    const options = available.runners.filter(r => r.ownerLogin === u.githubLogin || r.allowSharedRuns).flatMap(r => connectionStatuses(r.harnesses).filter(s => s.harness === harness).map(s => ({
      runnerId: r._id, machineName: r.displayName ?? r.name, owner: r.ownerLogin, connectionId: s.connectionId, name: s.connectionName, email: s.email ?? null, plan: s.plan ?? null,
      online: r.online && r.lastSeen > Date.now() - 90_000, authenticated: s.auth === "authenticated", isDefault: s.isDefault,
    })));
    try {
      const { runner, status, source } = await resolveForChat(ctx, chat, u.githubLogin!, harness, localRunnerId);
      const owner = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", runner.ownerLogin)).first();
      return { options, override, error: null, selected: { runnerId: runner._id, machineName: runner.displayName ?? runner.name, owner: owner?.username ?? runner.ownerLogin, connectionId: status.connectionId, name: status.connectionName, email: status.email ?? null, plan: status.plan ?? null, source, remote: runner._id !== localRunnerId, key: selectionKey(runner._id, status) } };
    } catch (e) { return { options, override, error: (e as Error).message, selected: null }; }
  },
});

export const preferences = query({ args: {}, handler: async ctx => {
  const user = await me(ctx);
  const preferences = user.accountPreferences ?? [];
  return [...preferences, ...(user.agentPreferences ?? []).filter(p => !preferences.some(a => a.harness === p.harness)).map(({ harness, runnerId, connectionId }) => ({ harness, runnerId, connectionId }))];
} });
export const setPreference = mutation({
  args: { harness: v.string(), chatId: v.optional(v.id("chats")), runnerId: v.optional(v.id("runners")), connectionId: v.optional(v.string()) },
  handler: async (ctx, { harness, chatId, runnerId, connectionId }) => {
    if (!["codex", "claude", "omp"].includes(harness)) throw new Error("Unknown harness");
    const user = await me(ctx);
    if (chatId) await requireChat(ctx, chatId);
    if (runnerId) {
      const runner = await ctx.db.get(runnerId);
      if (!runner || (runner.ownerLogin !== user.githubLogin && !runner.allowSharedRuns)) throw new Error("This connection is not shared with you");
      if (runner.ownerLogin !== user.githubLogin) {
        const mine = await ctx.db.query("members").withIndex("by_login", q => q.eq("githubLogin", user.githubLogin!)).collect();
        const theirs = await ctx.db.query("members").withIndex("by_login", q => q.eq("githubLogin", runner.ownerLogin)).collect();
        if (!mine.some(m => theirs.some(t => t.workspaceId === m.workspaceId))) throw new Error("No shared workspace with this account owner");
      }
      if (!connectionStatuses(runner.harnesses).some(s => s.harness === harness && s.connectionId === (connectionId ?? "default"))) throw new Error("Unknown account connection");
    }
    const value = { harness, ...(runnerId ? { runnerId, connectionId: connectionId ?? "default" } : {}) };
    if (chatId) {
      const rest = (user.chatConnections ?? []).filter(p => !(p.chatId === chatId && p.harness === harness));
      await ctx.db.patch(user._id, { chatConnections: runnerId ? [...rest, { ...value, chatId }] : rest });
    } else await ctx.db.patch(user._id, { accountPreferences: [...(user.accountPreferences ?? []).filter(p => p.harness !== harness), value] });
  },
});
