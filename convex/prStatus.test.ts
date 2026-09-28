import { describe, expect, it } from "vitest";
import { EXPIRED, MAX_AUTO_FIXES, QUIET_MS, checkState, fixWork, keepPolling, mergeMethod, mergeWait, parsePrPage, parseRestPr, prPatch, refusal, summarizeChecks, type AutoFix, type CheckItem, type PrSnapshot, type RollupContext } from "./prStatus";

const run = (name: string, status: string, conclusion: string | null = null): RollupContext => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://ci/${name}` });
const status = (context: string, state: string): RollupContext => ({ __typename: "StatusContext", context, state, targetUrl: null });
const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN", merged: false, isDraft: false, title: "t", url: "https://github.com/acme/beam/pull/12", additions: 1, deletions: 2, changedFiles: 3, headRefOid: "h",
  author: null, openedAt: null, mergeable: null, reviewDecision: null, mergeMethod: null, comments: [], rollupState: null, items: [], ...over,
});
const item = (name: string, state: CheckItem["state"]): CheckItem => ({ name, state, url: null });

describe("checkState", () => {
  it("treats cancelled, timed out and errored checks as failures, skipped and stale as skipped", () => {
    expect([run("a", "COMPLETED", "CANCELLED"), run("b", "COMPLETED", "TIMED_OUT"), status("c", "ERROR")].map(checkState)).toEqual(["failed", "failed", "failed"]);
    expect([run("a", "COMPLETED", "SKIPPED"), run("b", "COMPLETED", "STALE")].map(checkState)).toEqual(["skipped", "skipped"]);
    expect([run("a", "COMPLETED", "NEUTRAL"), status("b", "SUCCESS")].map(checkState)).toEqual(["passed", "passed"]);
    expect([run("a", "IN_PROGRESS"), run("b", "QUEUED"), status("c", "EXPECTED")].map(checkState)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("summarizeChecks", () => {
  it("counts each kind of check and puts failures first", () => {
    const s = summarizeChecks([item("lint", "passed"), item("docs", "skipped"), item("e2e", "pending"), item("test", "failed")], null, 5);
    expect(s).toMatchObject({ state: "failing", passed: 1, failed: 1, pending: 1, skipped: 1, checkedAt: 5 });
    expect(s.items.map((i) => i.name)).toEqual(["test", "e2e", "lint", "docs"]);
  });

  it("is pending while anything runs, passing once all pass or skip, none with no checks", () => {
    expect(summarizeChecks([item("a", "passed"), item("b", "pending")], null, 0).state).toBe("pending");
    expect(summarizeChecks([item("a", "passed"), item("b", "skipped")], null, 0).state).toBe("passing");
    expect(summarizeChecks([], null, 0).state).toBe("none");
  });

  it("trusts GitHub's rollup over the checks it read, so a failure past the last page still shows", () => {
    expect(summarizeChecks([item("a", "passed")], "FAILURE", 0).state).toBe("failing");
    expect(summarizeChecks([item("a", "passed")], "PENDING", 0).state).toBe("pending");
    expect(summarizeChecks([item("a", "failed")], "PENDING", 0).state).toBe("failing");
    expect(summarizeChecks([item("a", "passed")], "SUCCESS", 0).state).toBe("passing");
  });
});

describe("parsePrPage", () => {
  const page = (rollup: unknown = { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [run("test", "COMPLETED", "SUCCESS"), {}] } }) => ({ data: { repository: { pullRequest: {
    state: "OPEN", merged: false, isDraft: true, title: "Add workspace deletion", url: "https://github.com/acme/beam/pull/12", additions: 137, deletions: 11, changedFiles: 6, headRefOid: "abc123",
    commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  } } } });

  it("reads the PR, its checks and the next page, skipping nodes that are not checks", () => {
    const r = parsePrPage(page());
    if ("error" in r) throw new Error(r.error);
    expect(r.next).toBeNull();
    expect(r.pr).toMatchObject({ title: "Add workspace deletion", isDraft: true, headRefOid: "abc123", rollupState: "SUCCESS", items: [{ name: "test", state: "passed", url: "https://ci/test" }] });
    const more = parsePrPage(page({ state: "PENDING", contexts: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] } }));
    expect("next" in more && more.next).toBe("c1");
  });

  it("reads who opened the PR, whether it can merge, and the review comments still open", () => {
    const thread = (id: string, over: Record<string, unknown> = {}) => ({ id, isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, comments: { nodes: [{ author: { login: "noah" }, body: `fix ${id}`, url: `u/${id}` }] }, ...over });
    const full = { data: { repository: { viewerDefaultMergeMethod: "SQUASH", pullRequest: { ...page().data.repository.pullRequest,
      author: { login: "apekshik" }, createdAt: "2026-09-27T10:00:00Z", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED",
      reviewThreads: { nodes: [thread("t1"), thread("t2", { isResolved: true }), thread("t3", { isOutdated: true }), thread("t4", { comments: { nodes: [] } })] },
      latestReviews: { nodes: [
        { id: "r1", state: "CHANGES_REQUESTED", author: null, body: "Needs tests", url: "u/r1" },
        { id: "r2", state: "CHANGES_REQUESTED", author: { login: "noah" }, body: "  ", url: null },
        { id: "r3", state: "APPROVED", author: { login: "noah" }, body: "LGTM", url: null },
      ] },
    } } } };
    const r = parsePrPage(full);
    if ("error" in r) throw new Error(r.error);
    expect(r.pr).toMatchObject({ author: "apekshik", openedAt: Date.parse("2026-09-27T10:00:00Z"), mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", mergeMethod: "SQUASH" });
    expect(r.pr.comments).toEqual([
      { id: "t1", path: "src/a.ts", line: 3, author: "noah", body: "fix t1", url: "u/t1" },
      { id: "r1", path: null, line: null, author: null, body: "Needs tests", url: "u/r1" },
    ]);
    // A reply without the newer fields still syncs.
    const bare = parsePrPage(page());
    expect("pr" in bare && bare.pr).toMatchObject({ author: null, openedAt: null, mergeable: null, comments: [] });
  });

  it("has no checks when the head commit has no rollup", () => {
    const r = parsePrPage(page(null));
    expect("pr" in r && r.pr.items).toEqual([]);
    expect("pr" in r && r.pr.rollupState).toBeNull();
  });

  it("rejects a malformed response at the boundary instead of passing it on", () => {
    const bad = page(); (bad.data.repository.pullRequest as Record<string, unknown>).additions = "137";
    expect(parsePrPage(bad)).toMatchObject({ error: expect.stringContaining("additions") });
    expect(parsePrPage({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository", type: "NOT_FOUND" }] })).toEqual({ error: "Could not resolve to a Repository", kind: "forbidden" });
    expect(parsePrPage({ data: { repository: { pullRequest: null } } })).toEqual({ error: "pull request not found", kind: "forbidden" });
    expect(parsePrPage({ data: null, errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }] })).toMatchObject({ kind: "rate-limited" });
    expect(parsePrPage({ data: null, errors: [{ message: "Something went wrong", type: "INTERNAL" }] })).toMatchObject({ kind: "other" });
    expect(parsePrPage("nope")).toMatchObject({ error: expect.any(String) });
  });
});

describe("prPatch", () => {
  const snap = pr();
  it("stores the PR's URL so a change that only knew its number can link to it", () => {
    expect(prPatch(snap, 0).patch).toMatchObject({ prUrl: "https://github.com/acme/beam/pull/12", add: 1, del: 2, files: 3, headSha: "h", draft: false });
  });
  it("reports merged and closed PRs", () => {
    expect(prPatch({ ...snap, state: "MERGED", merged: true }, 0).resolved).toBe("merged");
    expect(prPatch({ ...snap, state: "CLOSED" }, 0).resolved).toBe("closed");
    expect(prPatch(snap, 0).resolved).toBeNull();
  });
});

describe("fixWork", () => {
  const failing = summarizeChecks([item("test", "failed"), item("lint", "passed")], null, 0);
  const auto = (over: Partial<AutoFix> = {}): AutoFix => ({ by: "me", agentId: "a", attempts: 0, addressed: [], ...over });
  const cm = (id: string) => ({ id, path: null, line: null, author: null, body: id, url: null });

  it("asks once per head for failing CI, once all checks have finished", () => {
    expect(fixWork({ headSha: "h1", checks: failing }, auto())).toMatchObject({ failing: ["test"], any: true });
    expect(fixWork({ headSha: "h1", checks: failing }, auto({ sha: "h1" })).any).toBe(false);
    expect(fixWork({ headSha: "h2", checks: failing }, auto({ sha: "h1" })).failing).toEqual(["test"]);
    expect(fixWork({ headSha: "h1", checks: summarizeChecks([item("test", "failed"), item("e2e", "pending")], null, 0) }, auto()).any).toBe(false);
    expect(fixWork({ headSha: "h1", checks: summarizeChecks([item("test", "passed")], null, 0) }, auto()).any).toBe(false);
  });

  it("stops at the limit and says so", () => {
    expect(fixWork({ headSha: "h9", checks: failing }, auto({ attempts: MAX_AUTO_FIXES, sha: "h8" }))).toMatchObject({ failing: null, capped: true, any: false });
  });

  it("asks about each review comment once, whatever the head", () => {
    const w = fixWork({ headSha: "h1", comments: [cm("t1"), cm("t2")] }, auto({ addressed: ["t1"] }));
    expect(w).toMatchObject({ failing: null, any: true });
    expect(w.comments.map((c) => c.id)).toEqual(["t2"]);
    expect(fixWork({ headSha: "h2", comments: [cm("t1")] }, auto({ addressed: ["t1"] })).any).toBe(false);
  });
});

describe("mergeWait", () => {
  const passing = summarizeChecks([item("test", "passed")], null, 0);
  const none = summarizeChecks([], null, 0);
  const ready = { state: "OPEN" as const, isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", comments: [] };
  it("is ready once checks pass, GitHub says it can merge, reviews allow it and no comments are open", () => {
    expect(mergeWait(ready, passing, 0, 1)).toBeNull();
    expect(mergeWait({ ...ready, reviewDecision: null }, passing, 0, 1)).toBeNull();
  });
  it("names what it is waiting for", () => {
    expect(mergeWait({ ...ready, isDraft: true }, passing, 0, 1)).toMatch(/draft/);
    expect(mergeWait(ready, summarizeChecks([item("t", "pending")], null, 0), 0, 1)).toMatch(/checks to finish/);
    expect(mergeWait(ready, summarizeChecks([item("t", "failed")], null, 0), 0, 1)).toMatch(/failing checks/);
    expect(mergeWait({ ...ready, mergeable: "CONFLICTING" }, passing, 0, 1)).toMatch(/conflicts/);
    expect(mergeWait({ ...ready, mergeable: "UNKNOWN" }, passing, 0, 1)).toMatch(/can merge/);
    expect(mergeWait({ ...ready, reviewDecision: "CHANGES_REQUESTED" }, passing, 0, 1)).toMatch(/requested changes/);
    expect(mergeWait({ ...ready, reviewDecision: "REVIEW_REQUIRED" }, passing, 0, 1)).toMatch(/required review/);
    expect(mergeWait({ ...ready, comments: [{ id: "t", path: null, line: null, author: null, body: "", url: null }] }, passing, 0, 1)).toMatch(/1 review comment to/);
  });
  it("gives a new head time for CI to register before taking no checks to mean none", () => {
    expect(mergeWait(ready, none, 1000, 1000 + QUIET_MS - 1)).toMatch(/checks to start/);
    expect(mergeWait(ready, none, 1000, 1000 + QUIET_MS)).toBeNull();
  });
  it("merges the way the merge button would", () => {
    expect([mergeMethod("SQUASH"), mergeMethod("REBASE"), mergeMethod("MERGE"), mergeMethod(null)]).toEqual(["squash", "rebase", "merge", "merge"]);
  });
});

describe("parseRestPr", () => {
  it("reads a created PR or the first of a list, and rejects anything else", () => {
    expect(parseRestPr({ html_url: "https://github.com/acme/beam/pull/7", number: 7, extra: 1 })).toEqual({ url: "https://github.com/acme/beam/pull/7", number: 7 });
    expect(parseRestPr([{ html_url: "https://github.com/acme/beam/pull/8", number: 8 }])).toEqual({ url: "https://github.com/acme/beam/pull/8", number: 8 });
    expect(parseRestPr([])).toBeNull();
    expect(parseRestPr({ html_url: "https://github.com/acme/beam/pull/7" })).toBeNull();
    expect(parseRestPr({ message: "Validation Failed" })).toBeNull();
  });
});

describe("keepPolling", () => {
  it("polls while checks run, briefly while none have registered, and never forever", () => {
    expect(keepPolling("pending", 10)).toBe(true);
    expect(keepPolling("pending", 60)).toBe(false);
    expect(keepPolling("none", 2)).toBe(true);
    expect(keepPolling("none", 4)).toBe(false);
    expect(keepPolling("passing", 0)).toBe(false);
    expect(keepPolling("failing", 0)).toBe(false);
  });
});

describe("refusal", () => {
  const headers = (h: Record<string, string> = {}) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
  it("tells a dead token from a repo the token can't see, and from rate limiting", () => {
    expect(refusal(401, headers())).toMatchObject({ kind: "expired", error: EXPIRED });
    expect(refusal(403, headers()).kind).toBe("forbidden");
    expect(refusal(404, headers()).kind).toBe("forbidden");
    expect(refusal(403, headers({ "x-ratelimit-remaining": "0" })).kind).toBe("rate-limited");
    expect(refusal(429, headers({ "retry-after": "60" })).kind).toBe("rate-limited");
    expect(refusal(502, headers())).toEqual({ kind: "other", error: "GitHub answered 502" });
  });
});
