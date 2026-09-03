import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/** The signed-in user's GitHub token, if sign-in granted the repo scope. Internal only. */
export const myToken = internalQuery({
  args: {},
  handler: async (ctx) => {
    const id = await getAuthUserId(ctx);
    if (!id) return null;
    const u = await ctx.db.get(id);
    if (!u?.githubToken) return null;
    return { token: u.githubToken, scope: u.githubTokenScope ?? "" };
  },
});

export interface RepoRow { name: string; private: boolean; pushedAt: number; description: string | null; owner: string }

/** Repos the user can push to, most recently pushed first. Null when sign-in predates the repo scope. */
export const myRepos = action({
  args: {},
  handler: async (ctx): Promise<{ repos: RepoRow[]; reason: null } | { repos: null; reason: "no-token" | "no-scope" | "github-error" }> => {
    const t = await ctx.runQuery(internal.github.myToken, {});
    if (!t) return { repos: null, reason: "no-token" };
    const repos: RepoRow[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, {
        headers: { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "user-agent": "beam" },
      });
      if (res.status === 401 || res.status === 403) return { repos: null, reason: "no-scope" };
      if (!res.ok) return { repos: null, reason: "github-error" };
      const rows = (await res.json()) as { full_name: string; private: boolean; pushed_at: string; description: string | null; owner: { login: string }; permissions?: { push?: boolean } }[];
      for (const r of rows) if (r.permissions?.push !== false) repos.push({ name: r.full_name, private: r.private, pushedAt: Date.parse(r.pushed_at), description: r.description, owner: r.owner.login });
      if (rows.length < 100) break;
    }
    return { repos, reason: null };
  },
});


/** Open changes with a PR, plus a token that can read each one (the person who created it, else any member with a token). */
export const openChangesWithTokens = internalQuery({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db.query("changes").withIndex("by_state", (q) => q.eq("state", "open")).collect();
    const out: { id: typeof open[number]["_id"]; repo: string; prNumber: number; token: string }[] = [];
    for (const c of open) {
      if (!c.prNumber) continue;
      let token: string | null = null;
      const creator = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", c.createdBy)).first();
      if (creator?.githubToken) token = creator.githubToken;
      else {
        const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", c.workspaceId)).collect();
        for (const m of members) { const u = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", m.githubLogin)).first(); if (u?.githubToken) { token = u.githubToken; break; } }
      }
      if (token) out.push({ id: c._id, repo: c.repo, prNumber: c.prNumber, token });
    }
    return out;
  },
});

export const markResolved = internalMutation({
  args: { changeId: v.id("changes"), state: v.string() },
  handler: async (ctx, { changeId, state }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.state !== "open") return;
    await ctx.db.patch(changeId, { state, resolvedAt: Date.now() });
  },
});

/** Every few minutes: did any open PR merge or close? Keeps the change chips honest without anyone running anything. */
export const syncChanges = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.github.openChangesWithTokens, {});
    for (const r of rows) {
      try {
        const res = await fetch(`https://api.github.com/repos/${r.repo}/pulls/${r.prNumber}`, { headers: { authorization: `Bearer ${r.token}`, accept: "application/vnd.github+json", "user-agent": "beam" } });
        if (!res.ok) continue;
        const pr = (await res.json()) as { state: string; merged: boolean };
        if (pr.merged) await ctx.runMutation(internal.github.markResolved, { changeId: r.id, state: "merged" });
        else if (pr.state === "closed") await ctx.runMutation(internal.github.markResolved, { changeId: r.id, state: "closed" });
      } catch (e) { console.error("syncChanges", r.repo, r.prNumber, (e as Error).message); }
    }
  },
});
