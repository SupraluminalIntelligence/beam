import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalQuery } from "./_generated/server";
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

