import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { me, requireMember } from "./lib";
import { sha256 } from "./runnerAuth";

/** Runner calls authenticate with their token, not with Convex Auth. */
async function requireRunner(ctx: QueryCtx | MutationCtx, token: string) {
  const hash = await sha256(token);
  const t = await ctx.db.query("runnerTokens").withIndex("by_hash", (q) => q.eq("tokenHash", hash)).first();
  if (!t || t.revokedAt) throw new Error("runner token invalid or revoked");
  return t;
}

/** First contact after start. Upserts the runner row for this token. */
export const hello = mutation({
  args: { token: v.string(), name: v.string(), hostname: v.string(), platform: v.string(), harnesses: v.any(), launchedByApp: v.boolean() },
  handler: async (ctx, a) => {
    const t = await requireRunner(ctx, a.token);
    const existing = await ctx.db.query("runners").withIndex("by_token", (q) => q.eq("tokenId", t._id)).first();
    const fields = { ownerLogin: t.githubLogin, name: a.name, hostname: a.hostname, platform: a.platform, online: true, lastSeen: Date.now(), harnesses: a.harnesses, launchedByApp: a.launchedByApp };
    if (existing) { await ctx.db.patch(existing._id, fields); return existing._id; }
    return ctx.db.insert("runners", { tokenId: t._id, probeRequestedAt: 0, ...fields });
  },
});

export const heartbeat = mutation({
  args: { token: v.string(), runnerId: v.id("runners"), harnesses: v.optional(v.any()) },
  handler: async (ctx, { token, runnerId, harnesses }) => {
    const t = await requireRunner(ctx, token);
    const r = await ctx.db.get(runnerId);
    if (!r || r.tokenId !== t._id) throw new Error("not your runner");
    await ctx.db.patch(runnerId, { online: true, lastSeen: Date.now(), ...(harnesses === undefined ? {} : { harnesses }) });
  },
});

export const bye = mutation({
  args: { token: v.string(), runnerId: v.id("runners") },
  handler: async (ctx, { token, runnerId }) => {
    const t = await requireRunner(ctx, token);
    const r = await ctx.db.get(runnerId);
    if (r && r.tokenId === t._id) await ctx.db.patch(runnerId, { online: false });
  },
});

/** The runner subscribes to its own row so a probe request from the app reaches it live. */
export const self = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const t = await requireRunner(ctx, token);
    return ctx.db.query("runners").withIndex("by_token", (q) => q.eq("tokenId", t._id)).first();
  },
});

const FRESH = 90_000;
const shape = (r: { _id: unknown; name: string; hostname: string; platform: string; ownerLogin: string; online: boolean; lastSeen: number; harnesses: unknown; launchedByApp: boolean }) =>
  ({ id: r._id, name: r.name, hostname: r.hostname, platform: r.platform, ownerLogin: r.ownerLogin, online: r.online && r.lastSeen > Date.now() - FRESH, lastSeen: r.lastSeen, harnesses: r.harnesses, launchedByApp: r.launchedByApp });

/** My runners, for Settings → Connected harnesses. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const u = await me(ctx).catch(() => null);
    if (!u) return [];
    const rows = await ctx.db.query("runners").withIndex("by_owner", (q) => q.eq("ownerLogin", u.githubLogin!)).collect();
    return rows.map(shape);
  },
});

/** Runners available to a workspace: every member's online runners. */
export const online = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    const out = [];
    for (const m of members) {
      const rows = await ctx.db.query("runners").withIndex("by_owner", (q) => q.eq("ownerLogin", m.githubLogin)).collect();
      for (const r of rows) if (r.online && r.lastSeen > Date.now() - FRESH) out.push(shape(r));
    }
    return out;
  },
});

export const requestProbe = mutation({
  args: { runnerId: v.id("runners") },
  handler: async (ctx, { runnerId }) => {
    const u = await me(ctx);
    const r = await ctx.db.get(runnerId);
    if (!r || r.ownerLogin !== u.githubLogin) throw new Error("not your runner");
    await ctx.db.patch(runnerId, { probeRequestedAt: Date.now() });
  },
});
