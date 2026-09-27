import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { me } from "./lib";
import { sha256 } from "./runnerAuth";
import { Scope } from "../packages/contracts/src/layer";

/**
 * Tokens for interaction layers: interfaces built on Beam outside this codebase. A layer signs in with a
 * device code like a runner does, shows it to the person, and gets a token once they approve the scopes it
 * asked for. Only the v1 functions accept these tokens, so a layer can never reach the rest of the API.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const random = (len: number, map: (b: number) => string) => Array.from(crypto.getRandomValues(new Uint8Array(len)), map).join("");
const randomCode = (len: number) => random(len, (b) => ALPHABET[b % ALPHABET.length]!);
const TTL = 15 * 60_000;

/** Scopes as asked for, deduplicated, always with read. Unknown ones refuse the request rather than silently narrowing it. */
export function parseScopes(input: unknown): Scope[] {
  const list = Array.isArray(input) ? input : [];
  const scopes = [...new Set(["read", ...list.map(String)])];
  for (const s of scopes) if (!Scope.safeParse(s).success) throw new Error(`unknown scope "${s}"`);
  return scopes as Scope[];
}

export const start = internalMutation({
  args: { name: v.string(), hostname: v.string(), scopes: v.array(v.string()) },
  handler: async (ctx, { name, hostname, scopes }) => {
    const deviceCode = "bld_" + random(32, (b) => b.toString(16).padStart(2, "0"));
    const userCode = `${randomCode(4)}-${randomCode(4)}`;
    const expiresAt = Date.now() + TTL;
    await ctx.db.insert("deviceCodes", { deviceCode, userCode, kind: "layer", scopes, name, hostname, status: "pending", expiresAt, token: null, githubLogin: null });
    return { deviceCode, userCode, expiresAt };
  },
});

export const poll = internalMutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }) => {
    const row = await ctx.db.query("deviceCodes").withIndex("by_device", (q) => q.eq("deviceCode", deviceCode)).first();
    if (!row || row.kind !== "layer") return { status: "unknown" as const };
    if (row.expiresAt < Date.now()) { await ctx.db.delete(row._id); return { status: "expired" as const }; }
    if (row.status === "denied") { await ctx.db.delete(row._id); return { status: "denied" as const }; }
    if (row.status !== "approved" || !row.token) return { status: "pending" as const };
    await ctx.db.delete(row._id);
    return { status: "approved" as const, token: row.token, githubLogin: row.githubLogin!, scopes: row.scopes ?? ["read"] };
  },
});

const normalize = (userCode: string) => userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
async function waiting(ctx: QueryCtx | MutationCtx, userCode: string) {
  const row = await ctx.db.query("deviceCodes").withIndex("by_user_code", (q) => q.eq("userCode", normalize(userCode))).first();
  return row && row.kind === "layer" && row.expiresAt > Date.now() ? row : null;
}

/** What a layer is asking for, shown before anyone approves it. */
export const pending = query({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    await me(ctx);
    const row = await waiting(ctx, userCode);
    return row ? { name: row.name, hostname: row.hostname, scopes: row.scopes ?? ["read"], status: row.status } : null;
  },
});

export const approve = mutation({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    const u = await me(ctx);
    const row = await waiting(ctx, userCode);
    if (!row || row.status === "denied") throw new Error("That code is not waiting for approval");
    if (row.status === "approved") return { name: row.name, already: true };
    const token = "blt_" + random(32, (b) => b.toString(16).padStart(2, "0"));
    await ctx.db.insert("layerTokens", { tokenHash: await sha256(token), githubLogin: u.githubLogin!, name: row.name, hostname: row.hostname, scopes: row.scopes ?? ["read"], createdAt: Date.now(), revokedAt: null });
    await ctx.db.patch(row._id, { status: "approved", token, githubLogin: u.githubLogin! });
    return { name: row.name, already: false };
  },
});

export const deny = mutation({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    await me(ctx);
    const row = await waiting(ctx, userCode);
    if (row && row.status === "pending") await ctx.db.patch(row._id, { status: "denied" });
  },
});

/** Your connected layers, newest first. Revoked ones stay listed for a week so a revoke is visible. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const u = await me(ctx);
    const rows = await ctx.db.query("layerTokens").withIndex("by_login", (q) => q.eq("githubLogin", u.githubLogin!)).collect();
    const cutoff = Date.now() - 7 * 86_400_000;
    return rows.filter((r) => !r.revokedAt || r.revokedAt > cutoff).sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ id: r._id, name: r.name, hostname: r.hostname, scopes: r.scopes, createdAt: r.createdAt, revokedAt: r.revokedAt }));
  },
});

export const revoke = mutation({
  args: { id: v.id("layerTokens") },
  handler: async (ctx, { id }) => {
    const u = await me(ctx);
    const t = await ctx.db.get(id);
    if (!t || t.githubLogin !== u.githubLogin) throw new Error("not yours");
    if (!t.revokedAt) await ctx.db.patch(id, { revokedAt: Date.now() });
  },
});

/** Every v1 call starts here: a live token with the scope, and the person it acts for. */
export async function requireLayer(ctx: QueryCtx | MutationCtx, token: string, scope: Scope = "read") {
  const hash = await sha256(token);
  const t = await ctx.db.query("layerTokens").withIndex("by_hash", (q) => q.eq("tokenHash", hash)).first();
  if (!t || t.revokedAt) throw new Error("layer token invalid or revoked");
  if (!t.scopes.includes(scope)) throw new Error(`this token may not ${scope}`);
  return { token: t, login: t.githubLogin };
}
