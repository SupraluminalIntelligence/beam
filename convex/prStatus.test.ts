import { describe, expect, it } from "vitest";
import { keepPolling, prPatch, summarizeChecks, type GitHubPr, type RollupContext } from "./prStatus";

const run = (name: string, status: string, conclusion: string | null = null): RollupContext => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://ci/${name}` });
const status = (context: string, state: string): RollupContext => ({ __typename: "StatusContext", context, state, targetUrl: null });

describe("summarizeChecks", () => {
  it("counts each kind of check and puts failures first", () => {
    const s = summarizeChecks([
      run("lint", "COMPLETED", "SUCCESS"), run("docs", "COMPLETED", "SKIPPED"), run("e2e", "IN_PROGRESS"),
      run("test", "COMPLETED", "FAILURE"), status("vercel", "SUCCESS"), run("neutral", "COMPLETED", "NEUTRAL"),
    ], 5);
    expect(s).toMatchObject({ state: "failing", passed: 3, failed: 1, pending: 1, skipped: 1, checkedAt: 5 });
    expect(s.items.map((i) => i.name)).toEqual(["test", "e2e", "lint", "vercel", "neutral", "docs"]);
    expect(s.items[0]!.url).toBe("https://ci/test");
  });

  it("treats cancelled, timed out and errored checks as failures", () => {
    expect(summarizeChecks([run("a", "COMPLETED", "CANCELLED"), run("b", "COMPLETED", "TIMED_OUT"), status("c", "ERROR")], 0).failed).toBe(3);
  });

  it("is pending while anything runs, passing once all pass or skip, none with no checks", () => {
    expect(summarizeChecks([run("a", "COMPLETED", "SUCCESS"), run("b", "QUEUED")], 0).state).toBe("pending");
    expect(summarizeChecks([status("a", "EXPECTED")], 0).state).toBe("pending");
    expect(summarizeChecks([run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "SKIPPED")], 0).state).toBe("passing");
    expect(summarizeChecks([], 0).state).toBe("none");
  });
});

describe("prPatch", () => {
  const pr = (over: Partial<GitHubPr> = {}): GitHubPr => ({
    state: "OPEN", merged: false, isDraft: true, title: "Add workspace deletion", additions: 137, deletions: 11, changedFiles: 6, headRefOid: "abc123",
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [run("test", "COMPLETED", "SUCCESS"), {}] } } } }] },
    ...over,
  });

  it("reads the PR's title, size, head and checks, skipping contexts GitHub left empty", () => {
    const { resolved, patch } = prPatch(pr(), 9);
    expect(resolved).toBeNull();
    expect(patch).toMatchObject({ title: "Add workspace deletion", draft: true, headSha: "abc123", add: 137, del: 11, files: 6 });
    expect(patch.checks).toMatchObject({ state: "passing", passed: 1, items: [{ name: "test" }] });
  });

  it("reports merged and closed PRs", () => {
    expect(prPatch(pr({ state: "MERGED", merged: true }), 0).resolved).toBe("merged");
    expect(prPatch(pr({ state: "CLOSED" }), 0).resolved).toBe("closed");
  });

  it("has no checks when the head commit has no rollup", () => {
    expect(prPatch(pr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), 0).patch.checks.state).toBe("none");
    expect(prPatch(pr({ commits: { nodes: [] } }), 0).patch.checks.state).toBe("none");
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
