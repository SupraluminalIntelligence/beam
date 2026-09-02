import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { me } from "./lib";

/** Device-code login for runners. The runner never sees a browser; the signed-in app approves the code. */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return "brt_" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const start = internalMutation({
  args: { name: v.string(), hostname: v.string() },
  handler: async (ctx, { name, hostname }) => {
    const deviceCode = randomToken();
    const userCode = `${randomCode(4)}-${randomCode(4)}`;
    await ctx.db.insert("deviceCodes", { deviceCode, userCode, name, hostname, status: "pending", expiresAt: Date.now() + 15 * 60_000, token: null, githubLogin: null });
    return { deviceCode, userCode, expiresAt: Date.now() + 15 * 60_000 };
  },
});

export const poll = internalMutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }) => {
    const row = await ctx.db.query("deviceCodes").withIndex("by_device", (q) => q.eq("deviceCode", deviceCode)).first();
    if (!row) return { status: "unknown" as const };
    if (row.expiresAt < Date.now()) { await ctx.db.delete(row._id); return { status: "expired" as const }; }
    if (row.status !== "approved" || !row.token) return { status: "pending" as const };
    await ctx.db.delete(row._id);
    return { status: "approved" as const, token: row.token, githubLogin: row.githubLogin! };
  },
});

/** Called from the app by a signed-in person. Mints the runner's token; the runner picks it up on its next poll. */
export const approve = mutation({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    const u = await me(ctx);
    const code = userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
    const row = await ctx.db.query("deviceCodes").withIndex("by_user_code", (q) => q.eq("userCode", code)).first();
    if (!row || row.expiresAt < Date.now()) throw new Error("That code is not waiting for approval");
    if (row.status === "approved") return { name: row.name, already: true };
    const token = randomToken();
    await ctx.db.insert("runnerTokens", { tokenHash: await sha256(token), githubLogin: u.githubLogin!, name: row.name, createdAt: Date.now(), revokedAt: null });
    await ctx.db.patch(row._id, { status: "approved", token, githubLogin: u.githubLogin! });
    return { name: row.name, already: false };
  },
});

export const pending = query({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    const code = userCode.trim().toUpperCase();
    const row = await ctx.db.query("deviceCodes").withIndex("by_user_code", (q) => q.eq("userCode", code)).first();
    return row && row.expiresAt > Date.now() ? { name: row.name, hostname: row.hostname, status: row.status } : null;
  },
});

export const revoke = mutation({
  args: { tokenId: v.id("runnerTokens") },
  handler: async (ctx, { tokenId }) => {
    const u = await me(ctx);
    const t = await ctx.db.get(tokenId);
    if (!t || t.githubLogin !== u.githubLogin) throw new Error("not yours");
    await ctx.db.patch(tokenId, { revokedAt: Date.now() });
  },
});
