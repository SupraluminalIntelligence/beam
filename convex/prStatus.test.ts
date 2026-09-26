import { describe, expect, it } from "vitest";
import { checkState, keepPolling, parsePrPage, prPatch, summarizeChecks, type CheckItem, type RollupContext } from "./prStatus";

const run = (name: string, status: string, conclusion: string | null = null): RollupContext => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://ci/${name}` });
const status = (context: string, state: string): RollupContext => ({ __typename: "StatusContext", context, state, targetUrl: null });
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

  it("has no checks when the head commit has no rollup", () => {
    const r = parsePrPage(page(null));
    expect("pr" in r && r.pr.items).toEqual([]);
    expect("pr" in r && r.pr.rollupState).toBeNull();
  });

  it("rejects a malformed response at the boundary instead of passing it on", () => {
    const bad = page(); (bad.data.repository.pullRequest as Record<string, unknown>).additions = "137";
    expect(parsePrPage(bad)).toMatchObject({ error: expect.stringContaining("additions") });
    expect(parsePrPage({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] })).toEqual({ error: "Could not resolve to a Repository" });
    expect(parsePrPage("nope")).toMatchObject({ error: expect.any(String) });
  });
});

describe("prPatch", () => {
  const snap = { state: "OPEN" as const, merged: false, isDraft: false, title: "t", url: "https://github.com/acme/beam/pull/12", additions: 1, deletions: 2, changedFiles: 3, headRefOid: "h", rollupState: null, items: [] };
  it("stores the PR's URL so a change that only knew its number can link to it", () => {
    expect(prPatch(snap, 0).patch).toMatchObject({ prUrl: "https://github.com/acme/beam/pull/12", add: 1, del: 2, files: 3, headSha: "h", draft: false });
  });
  it("reports merged and closed PRs", () => {
    expect(prPatch({ ...snap, state: "MERGED", merged: true }, 0).resolved).toBe("merged");
    expect(prPatch({ ...snap, state: "CLOSED" }, 0).resolved).toBe("closed");
    expect(prPatch(snap, 0).resolved).toBeNull();
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
