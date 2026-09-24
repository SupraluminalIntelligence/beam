import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import { requireChat, requireMember, me } from "./lib";
import { runnerForToken } from "./runners";
import { ownRun } from "./runs";
import { ResourceOperation } from "../packages/contracts/src/resources";

async function membership(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">, login: string) {
  const members = await ctx.db.query("members").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).collect();
  if (!members.some(m => m.githubLogin === login)) throw new Error("Workspace access revoked");
}
export const contribute = mutation({
  args: { token: v.string(), chatId: v.id("chats"), localId: v.string(), name: v.string(), kind: v.union(v.literal("folder"), v.literal("service")) },
  handler: async (ctx, a) => {
    const runner = await runnerForToken(ctx, a.token); const chat = await ctx.db.get(a.chatId);
    if (!chat || chat.state === "deleted") throw new Error("No such chat");
    await membership(ctx, chat.workspaceId, runner.ownerLogin);
    if (chat.private && !chat.members.includes(runner.ownerLogin)) throw new Error("Private chat");
    if (!/^[\w-]{1,100}$/.test(a.localId) || !a.name.trim() || a.name.length > 120) throw new Error("Invalid resource");
    const existing = (await ctx.db.query("workspaceResources").withIndex("by_runner", q => q.eq("runnerId", runner._id)).collect()).find(r => r.localId === a.localId && r.workspaceId === chat.workspaceId);
    if (existing) return existing._id;
    const owner = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", runner.ownerLogin)).first();
    return ctx.db.insert("workspaceResources", { workspaceId: chat.workspaceId, chatId: chat._id, runnerId: runner._id, owner: runner.ownerLogin, localId: a.localId, name: a.name.trim(), kind: a.kind, shared: !chat.private && owner?.resourceSharing !== "ask", allowInstall: false, revoked: false });
  },
});
async function visibleResources(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">, login: string) {
  const chat = await ctx.db.get(chatId); if (!chat) throw new Error("No chat");
  await membership(ctx, chat.workspaceId, login);
  return (await ctx.db.query("workspaceResources").withIndex("by_workspace", q => q.eq("workspaceId", chat.workspaceId)).collect()).filter(r => !r.revoked && (r.shared || (r.owner === login && r.chatId === chatId)));
}
export const list = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  const { u } = await requireChat(ctx, chatId);
  return Promise.all((await visibleResources(ctx, chatId, u.githubLogin!)).map(async r => { const runner = await ctx.db.get(r.runnerId); const owner = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", r.owner)).first(); return { ...r, ownerName: owner?.username ?? r.owner, mine: r.owner === u.githubLogin, machineName: runner?.displayName ?? runner?.name ?? "Unknown machine", online: !!runner?.online && runner.lastSeen > Date.now() - 90_000 }; }));
} });
export const forRun = query({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  const { run } = await ownRun(ctx, a.token, a.runId);
  return (await visibleResources(ctx, run.chatId, run.dispatchedBy)).map(({ localId, ...r }) => r);
} });
export const setAccess = mutation({ args: { id: v.id("workspaceResources"), shared: v.optional(v.boolean()), allowInstall: v.optional(v.boolean()), revoked: v.optional(v.boolean()) }, handler: async (ctx, { id, ...patch }) => {
  const u = await me(ctx); const r = await ctx.db.get(id); if (!r || r.owner !== u.githubLogin) throw new Error("Only the owner can change access");
  await membership(ctx, r.workspaceId, u.githubLogin!); await ctx.db.patch(id, patch);
} });
export const setSharingPolicy = mutation({ args: { policy: v.union(v.literal("auto"), v.literal("ask")) }, handler: async (ctx, { policy }) => { await ctx.db.patch((await me(ctx))._id, { resourceSharing: policy }); } });
export const sharingPolicy = query({ args: {}, handler: async ctx => (await me(ctx)).resourceSharing ?? "auto" });

async function authorize(ctx: QueryCtx | MutationCtx, resource: Doc<"workspaceResources">, requestedBy: string, chatId: Id<"chats">) {
  const chat = await ctx.db.get(chatId);
  if (!chat || chat.state === "deleted" || chat.workspaceId !== resource.workspaceId || (chat.private && !chat.members.includes(requestedBy))) throw new Error("Resource is outside this chat's workspace");
  await membership(ctx, resource.workspaceId, requestedBy); await membership(ctx, resource.workspaceId, resource.owner);
  if (resource.revoked || (!resource.shared && (resource.owner !== requestedBy || resource.chatId !== chatId))) throw new Error("Resource access revoked");
}
export const request = mutation({
  args: { token: v.string(), runId: v.optional(v.id("runs")), chatId: v.optional(v.id("chats")), resourceId: v.id("workspaceResources"), operation: v.any() },
  handler: async (ctx, a) => {
    const requester = await runnerForToken(ctx, a.token);
    const run = a.runId ? (await ownRun(ctx, a.token, a.runId)).run : null;
    if (run && !["queued", "working", "starting"].includes(run.state)) throw new Error("Run has ended");
    const chatId = run?.chatId ?? a.chatId; if (!chatId) throw new Error("Chat required");
    const requestedBy = run?.dispatchedBy ?? requester.ownerLogin;
    const resource = await ctx.db.get(a.resourceId); if (!resource) throw new Error("No resource");
    await authorize(ctx, resource, requestedBy, chatId);
    const host = await ctx.db.get(resource.runnerId);
    if (!host?.online || host.lastSeen <= Date.now() - 90_000) throw new Error("Resource host is offline");
    const operation = ResourceOperation.parse(a.operation);
    if ((operation.kind === "http") !== (resource.kind === "service")) throw new Error("Unsupported resource operation");
    if (operation.kind === "command" && operation.install && !resource.allowInstall) throw new Error("The resource owner must enable dependency installation first");
    const id = await ctx.db.insert("resourceRequests", { resourceId: resource._id, runnerId: resource.runnerId, requesterRunnerId: requester._id, requestedBy, chatId, operation, state: "queued", createdAt: Date.now(), ...(run ? { sourceRunId: run._id } : {}) });
    await ctx.scheduler.runAfter(10 * 60_000, internal.resources.expire, { id });
    return id;
  },
});
export const queued = query({ args: { token: v.string() }, handler: async (ctx, { token }) => { const r = await runnerForToken(ctx, token); return ctx.db.query("resourceRequests").withIndex("by_runner_state", q => q.eq("runnerId", r._id).eq("state", "queued")).collect(); } });
export const claim = mutation({ args: { token: v.string(), id: v.id("resourceRequests") }, handler: async (ctx, { token, id }) => {
  const host = await runnerForToken(ctx, token); const request = await ctx.db.get(id);
  if (!request || request.runnerId !== host._id || request.state !== "queued") throw new Error("Request unavailable");
  const resource = await ctx.db.get(request.resourceId); if (!resource) throw new Error("Resource removed");
  try {
    await authorize(ctx, resource, request.requestedBy, request.chatId);
    if (request.createdAt < Date.now() - 25_000) throw new Error("Request expired before execution");
    if (request.operation.kind === "command" && request.operation.install && !resource.allowInstall) throw new Error("Installation permission revoked");
  } catch (e) { await ctx.db.patch(id, { state: "failed", error: (e as Error).message }); return null; }
  await ctx.db.patch(id, { state: "running" }); return { request, resource };
} });
export const finish = mutation({ args: { token: v.string(), id: v.id("resourceRequests"), result: v.optional(v.string()), error: v.optional(v.string()) }, handler: async (ctx, { token, id, result, error }) => {
  const r = await runnerForToken(ctx, token); const request = await ctx.db.get(id);
  if (!request || request.runnerId !== r._id || request.state !== "running") throw new Error("Not your active request");
  await ctx.db.patch(id, { state: error ? "failed" : "done", ...(error ? { error: error.slice(0, 500) } : { result: (result ?? "").slice(0, 700_000) }) });
} });
export const result = query({ args: { token: v.string(), id: v.id("resourceRequests") }, handler: async (ctx, { token, id }) => {
  const r = await runnerForToken(ctx, token); const request = await ctx.db.get(id);
  if (!request || request.requesterRunnerId !== r._id) throw new Error("Not your request");
  const resource = await ctx.db.get(request.resourceId); if (!resource) throw new Error("Resource removed");
  await authorize(ctx, resource, request.requestedBy, request.chatId);
  return { state: request.state, result: request.result ?? null, error: request.error ?? null };
} });

export const lease = query({ args: { token: v.string(), id: v.id("resourceRequests") }, handler: async (ctx, { token, id }) => {
  const host = await runnerForToken(ctx, token); const request = await ctx.db.get(id);
  if (!request || request.runnerId !== host._id || request.state !== "running") return false;
  const resource = await ctx.db.get(request.resourceId); if (!resource) return false;
  try {
    await authorize(ctx, resource, request.requestedBy, request.chatId);
    if (request.sourceRunId) { const run = await ctx.db.get(request.sourceRunId); if (!run || run.interruptRequestedAt || !["queued", "starting", "working"].includes(run.state)) return false; }
    return !(request.operation.kind === "command" && request.operation.install && !resource.allowInstall);
  } catch { return false; }
} });

/** File contents and preview responses are transient relay data, not permanent workspace copies. */
export const expire = internalMutation({ args: { id: v.id("resourceRequests") }, handler: async (ctx, { id }) => {
  const request = await ctx.db.get(id); if (!request) return;
  await ctx.db.patch(id, { operation: { kind: request.operation.kind }, result: undefined, error: undefined, state: "expired" });
} });
