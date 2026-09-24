import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { me as requireUser } from "./lib";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const id = await getAuthUserId(ctx);
    if (!id) return null;
    const u = await ctx.db.get(id);
    return u ? { id: u._id, name: u.username ?? u.githubLogin ?? "you", githubLogin: u.githubLogin ?? "", image: u.image ?? null, isAnonymous: !!u.isAnonymous } : null;
  },
});

export const byLogins = query({
  args: { logins: v.array(v.string()) },
  handler: async (ctx, { logins }) => {
    const out: Record<string, { name: string; image: string | null }> = {};
    for (const login of logins) {
      const u = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", login)).first();
      out[login] = { name: u?.username ?? login, image: u?.image ?? null };
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
      .filter((u) => !needle || u.githubLogin!.toLowerCase().includes(needle) || (u.username ?? "").toLowerCase().includes(needle) || (u.name ?? "").toLowerCase().includes(needle))
      .sort((a, b) => a.githubLogin!.localeCompare(b.githubLogin!))
      .slice(0, 20)
      .map((u) => ({ login: u.githubLogin!, name: u.username ?? u.githubLogin!, image: u.image ?? null }));
  },
});

/** Personal defaults apply to new dispatches, including automatically routed messages. */
export const preferences = query({
  args: {},
  handler: async (ctx) => (await requireUser(ctx)).agentPreferences ?? [],
});

export const setAgentPreference = mutation({
  args: { harness: v.string(), model: v.string(), effort: v.string(), runnerId: v.optional(v.id("runners")), connectionId: v.optional(v.string()) },
  handler: async (ctx, preference) => {
    const user = await requireUser(ctx);
    if (!["codex", "claude", "omp"].includes(preference.harness) || !preference.model.trim() || preference.model.length > 200 || !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(preference.effort)) throw new Error("Invalid agent preference");
    await ctx.db.patch(user._id, { agentPreferences: [...(user.agentPreferences ?? []).filter((p) => p.harness !== preference.harness), { ...preference, model: preference.model.trim() }] });
  },
});

/** Presentation identity is independent of GitHub membership, auth and historical message authors. */
export const setUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username: input }) => {
    const user = await requireUser(ctx);
    const username = input.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(username)) throw new Error("Use 2–32 letters, numbers, or hyphens. Start and end with a letter or number.");
    const taken = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", username)).first();
    const login = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", username)).first();
    if ((taken && taken._id !== user._id) || (login && login._id !== user._id)) throw new Error("That username is already in use.");
    const agents = await ctx.db.query("agents").collect();
    if (["codex", "claude", "omp", "beam"].includes(username) || agents.some(a => a.handle.toLowerCase() === username)) throw new Error("That name is reserved for an agent. Choose another username.");
    await ctx.db.patch(user._id, { username });
    return username;
  },
});
