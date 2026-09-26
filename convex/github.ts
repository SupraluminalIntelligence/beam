import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireChat } from "./lib";
import { startSync } from "./changes";
import { MAX_CHECK_PAGES, POLL_MS, PR_QUERY, keepPolling, parsePrPage, parseRestPr, prPatch, type ChecksSummary, type PrSnapshot } from "./prStatus";

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
    const out: { id: Id<"changes">; repo: string; prNumber: number; token: string; gen: number }[] = [];
    for (const c of open) {
      if (!c.prNumber) continue;
      const token = await tokenFor(ctx, c);
      if (token) out.push({ id: c._id, repo: c.repo, prNumber: c.prNumber, token, gen: c.syncGen ?? 0 });
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
    return { repo: c.repo, prNumber: c.prNumber, token: await tokenFor(ctx, c) };
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

const checkItemV = v.object({ name: v.string(), state: v.union(v.literal("passed"), v.literal("failed"), v.literal("pending"), v.literal("skipped")), url: v.union(v.string(), v.null()) });
const snapshotV = v.object({
  state: v.union(v.literal("OPEN"), v.literal("CLOSED"), v.literal("MERGED")), merged: v.boolean(), isDraft: v.boolean(), title: v.string(), url: v.string(),
  additions: v.number(), deletions: v.number(), changedFiles: v.number(), headRefOid: v.string(),
  rollupState: v.union(v.string(), v.null()), items: v.array(checkItemV),
});

/**
 * Writes what GitHub says about the PR. The last checks stay on the row after it merges or closes.
 * Every sync passes the generation it read: if a landing started a newer poll while this one was fetching, the
 * response is about an older head and is dropped.
 */
export const applyPr = internalMutation({
  args: { changeId: v.id("changes"), pr: snapshotV, gen: v.number() },
  handler: async (ctx, { changeId, pr, gen }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.state !== "open") return null;
    if ((c.syncGen ?? 0) !== gen) return null;
    const { resolved, patch } = prPatch(pr, Date.now());
    await ctx.db.patch(changeId, { ...patch, syncError: undefined, ...(resolved ? { state: resolved, resolvedAt: Date.now() } : {}) });
    return resolved ? null : patch.checks.state;
  },
});

/** Records why GitHub couldn't be read, so the checks popover says so instead of checking forever. */
export const markSyncError = internalMutation({
  args: { changeId: v.id("changes"), gen: v.number(), error: v.string() },
  handler: async (ctx, { changeId, gen, error }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.state !== "open" || (c.syncGen ?? 0) !== gen) return;
    await ctx.db.patch(changeId, { syncError: error.slice(0, 200) });
  },
});

/** The PR, its head commit and its checks, a page of checks per request. A later page failing keeps what the first ones read. */
async function fetchPr(repo: string, prNumber: number, token: string): Promise<PrSnapshot | { error: string }> {
  const [owner, name] = repo.split("/");
  let first: PrSnapshot | null = null;
  const items: PrSnapshot["items"] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_CHECK_PAGES; page++) {
    const res: Response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "beam" },
      body: JSON.stringify({ query: PR_QUERY, variables: { owner, name, number: prNumber, after } }),
    });
    if (!res.ok) { if (first) break; return { error: res.status === 401 || res.status === 403 ? "GitHub refused Beam's access to this PR" : `GitHub answered ${res.status}` }; }
    const parsed = parsePrPage(await res.json());
    if ("error" in parsed) { console.error("fetchPr", repo, prNumber, parsed.error); if (first) break; return { error: parsed.error }; }
    first ??= parsed.pr;
    items.push(...parsed.pr.items);
    after = parsed.next;
    if (!after) break;
  }
  return first ? { ...first, items } : { error: "no reply from GitHub" };
}

/** Every few minutes: state, diff size and CI for every open PR. Keeps the change chips honest without anyone running anything. */
export const syncChanges = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.github.openChangesWithTokens, {});
    for (const r of rows) {
      try {
        const pr = await fetchPr(r.repo, r.prNumber, r.token);
        // Both carry the generation read: a landing mid-fetch means this is about an older head.
        if ("error" in pr) await ctx.runMutation(internal.github.markSyncError, { changeId: r.id, gen: r.gen, error: pr.error });
        else await ctx.runMutation(internal.github.applyPr, { changeId: r.id, pr, gen: r.gen });
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
    if (!r.token) { await ctx.runMutation(internal.github.markSyncError, { changeId, gen, error: "No one in this workspace has given Beam GitHub access" }); return; }
    let next: boolean;
    try {
      const pr = await fetchPr(r.repo, r.prNumber, r.token);
      if ("error" in pr) {
        await ctx.runMutation(internal.github.markSyncError, { changeId, gen, error: pr.error });
        next = attempt < 3; // a blip gets a few retries; a lasting refusal shouldn't poll for half an hour
      } else {
        const checks = await ctx.runMutation(internal.github.applyPr, { changeId, pr, gen });
        next = !!checks && keepPolling(checks as ChecksSummary["state"], attempt);
      }
    } catch (e) {
      console.error("syncChange", r.repo, r.prNumber, (e as Error).message);
      await ctx.runMutation(internal.github.markSyncError, { changeId, gen, error: "couldn't reach GitHub" });
      next = attempt < 3;
    }
    if (next) await ctx.scheduler.runAfter(POLL_MS, internal.github.syncChange, { changeId, gen, attempt: attempt + 1 });
  },
});

/** The change a person wants a PR for, if they can see its thread and it has none yet. */
export const changeForPr = internalQuery({
  args: { changeId: v.id("changes") },
  handler: async (ctx, { changeId }) => {
    const c = await ctx.db.get(changeId);
    if (!c) throw new Error("no such change");
    await requireChat(ctx, c.chatId);
    return c.state === "open" && !c.prNumber ? { repo: c.repo, branch: c.branch, base: c.base, title: c.title } : null;
  },
});

export const setPr = internalMutation({
  args: { changeId: v.id("changes"), prUrl: v.string(), prNumber: v.number() },
  handler: async (ctx, { changeId, prUrl, prNumber }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.prNumber) return;
    await ctx.db.patch(changeId, { prUrl, prNumber, updatedAt: Date.now() });
    await startSync(ctx, changeId, 0);
  },
});

/** Someone clicked Create PR on a pushed branch. Opened with their own GitHub sign-in, so it is theirs, as if made on GitHub. */
export const createPr = action({
  args: { changeId: v.id("changes") },
  handler: async (ctx, { changeId }): Promise<{ url: string } | { error: string }> => {
    const c = await ctx.runQuery(internal.github.changeForPr, { changeId });
    if (!c) return { error: "This branch already has a PR." };
    const t = await ctx.runQuery(internal.github.myToken, {});
    if (!t) return { error: "Beam has no GitHub access for you. Sign out and back in to grant it." };
    const headers = { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "user-agent": "beam", "content-type": "application/json" };
    const res = await fetch(`https://api.github.com/repos/${c.repo}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: c.title, head: c.branch, base: c.base, body: "Opened from Beam." }) });
    let pr = res.ok ? parseRestPr(await res.json()) : null;
    if (!pr && res.status === 422) {
      // Someone already opened one for this branch: adopt it.
      const owner = c.repo.split("/")[0];
      const list = await fetch(`https://api.github.com/repos/${c.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${c.branch}`)}`, { headers });
      pr = list.ok ? parseRestPr(await list.json()) : null;
    }
    if (!pr) return { error: res.status === 403 || res.status === 404 ? `Your GitHub account can't open PRs on ${c.repo}.` : res.ok ? "GitHub may have opened the PR but sent back an unexpected reply. Click Create PR again to link it." : `GitHub refused the PR (${res.status}).` };
    await ctx.runMutation(internal.github.setPr, { changeId, prUrl: pr.url, prNumber: pr.number });
    return { url: pr.url };
  },
});
