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
