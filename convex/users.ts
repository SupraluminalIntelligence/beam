import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const id = await getAuthUserId(ctx);
    if (!id) return null;
    const u = await ctx.db.get(id);
    return u ? { id: u._id, name: u.name ?? u.githubLogin ?? "you", githubLogin: u.githubLogin ?? "", image: u.image ?? null, isAnonymous: !!u.isAnonymous } : null;
  },
});

export const byLogins = query({
  args: { logins: v.array(v.string()) },
  handler: async (ctx, { logins }) => {
    const out: Record<string, { name: string; image: string | null }> = {};
    for (const login of logins) {
      const u = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", login)).first();
      out[login] = { name: u?.name ?? login, image: u?.image ?? null };
    }
    return out;
  },
});

/** People who have signed in to Beam with GitHub, for the invite picker. Guests are left out; members already in the workspace too. */
export const directory = query({
  args: { workspaceId: v.id("workspaces"), q: v.string() },
  handler: async (ctx, { workspaceId, q }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return [];
    const members = new Set((await ctx.db.query("members").withIndex("by_workspace", (x) => x.eq("workspaceId", workspaceId)).collect()).map((m) => m.githubLogin));
    const all = await ctx.db.query("users").collect();
    const needle = q.trim().toLowerCase();
    return all
      .filter((u) => u.githubLogin && !u.isAnonymous && !members.has(u.githubLogin))
      .filter((u) => !needle || u.githubLogin!.toLowerCase().includes(needle) || (u.name ?? "").toLowerCase().includes(needle))
      .sort((a, b) => a.githubLogin!.localeCompare(b.githubLogin!))
      .slice(0, 20)
      .map((u) => ({ login: u.githubLogin!, name: u.name ?? u.githubLogin!, image: u.image ?? null }));
  },
});
