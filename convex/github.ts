import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { POLL_MS, PR_QUERY, keepPolling, prPatch, type ChecksSummary, type GitHubPr } from "./prStatus";

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


/** A token that can read a change's PR: the person who created it, else any member with a token. */
async function tokenFor(ctx: QueryCtx, c: Doc<"changes">): Promise<string | null> {
  const creator = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", c.createdBy)).first();
  if (creator?.githubToken) return creator.githubToken;
  const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", c.workspaceId)).collect();
  for (const m of members) { const u = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", m.githubLogin)).first(); if (u?.githubToken) return u.githubToken; }
  return null;
}

/** Open changes with a PR, plus a token that can read each one. */
export const openChangesWithTokens = internalQuery({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db.query("changes").withIndex("by_state", (q) => q.eq("state", "open")).collect();
    const out: { id: Id<"changes">; repo: string; prNumber: number; token: string }[] = [];
    for (const c of open) {
      if (!c.prNumber) continue;
      const token = await tokenFor(ctx, c);
      if (token) out.push({ id: c._id, repo: c.repo, prNumber: c.prNumber, token });
    }
    return out;
  },
});

/** One change for a targeted sync, or null when it has no PR, has left the open state, or a newer poll replaced this one. */
export const changeForSync = internalQuery({
  args: { changeId: v.id("changes"), gen: v.number() },
  handler: async (ctx, { changeId, gen }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.state !== "open" || !c.prNumber || (c.syncGen ?? 0) !== gen) return null;
    const token = await tokenFor(ctx, c);
    return token ? { repo: c.repo, prNumber: c.prNumber, token } : null;
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

/** Writes what GitHub says about the PR. The last checks stay on the row after it merges or closes. */
export const applyPr = internalMutation({
  args: { changeId: v.id("changes"), pr: v.any() },
  handler: async (ctx, { changeId, pr }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.state !== "open") return null;
    const { resolved, patch } = prPatch(pr as GitHubPr, Date.now());
    await ctx.db.patch(changeId, { ...patch, ...(resolved ? { state: resolved, resolvedAt: Date.now() } : {}) });
    return resolved ? null : patch.checks.state;
  },
});

/** The PR, its head commit and every check on it, in one request. Null on any GitHub error. */
async function fetchPr(repo: string, prNumber: number, token: string): Promise<GitHubPr | null> {
  const [owner, name] = repo.split("/");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "beam" },
    body: JSON.stringify({ query: PR_QUERY, variables: { owner, name, number: prNumber } }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { repository?: { pullRequest?: GitHubPr | null } | null }; errors?: { message: string }[] };
  if (body.errors?.length) console.error("fetchPr", repo, prNumber, body.errors[0]!.message);
  return body.data?.repository?.pullRequest ?? null;
}

/** Every few minutes: state, diff size and CI for every open PR. Keeps the change chips honest without anyone running anything. */
export const syncChanges = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.github.openChangesWithTokens, {});
    for (const r of rows) {
      try {
        const pr = await fetchPr(r.repo, r.prNumber, r.token);
        if (pr) await ctx.runMutation(internal.github.applyPr, { changeId: r.id, pr });
      } catch (e) { console.error("syncChanges", r.repo, r.prNumber, (e as Error).message); }
    }
  },
});

/** One PR, soon after a push or when someone opens its checks, repeating while CI runs. */
export const syncChange = internalAction({
  args: { changeId: v.id("changes"), gen: v.number(), attempt: v.number() },
  handler: async (ctx, { changeId, gen, attempt }) => {
    const r = await ctx.runQuery(internal.github.changeForSync, { changeId, gen });
    if (!r) return;
    let checks: string | null = "pending";
    try {
      const pr = await fetchPr(r.repo, r.prNumber, r.token);
      checks = pr ? await ctx.runMutation(internal.github.applyPr, { changeId, pr }) : "pending";
    } catch (e) { console.error("syncChange", r.repo, r.prNumber, (e as Error).message); }
    if (checks && keepPolling(checks as ChecksSummary["state"], attempt)) await ctx.scheduler.runAfter(POLL_MS, internal.github.syncChange, { changeId, gen, attempt: attempt + 1 });
  },
});
