import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "u1" }));
vi.mock("./messages", () => ({ sendAs: vi.fn(async () => ({ id: "m1", kind: "dispatch", runner: "mac" })) }));
vi.mock("./runs", async (orig) => ({ ...(await orig<typeof import("./runs")>()), chooseRunner: vi.fn(async () => ({ name: "mac" })) }));
import { sendAs } from "./messages";
import { chooseRunner } from "./runs";
import { applyPr, noteMerge, syncChanges, openChangesWithTokens, tokenOf } from "./github";
import { setAuto } from "./changes";
import type { PrSnapshot } from "./prStatus";

const call = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);

function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: "u1", githubLogin: "noah", githubToken: "noah-token" }, { _id: "u2", githubLogin: "apekshik", githubToken: "ap-token" }],
    members: [{ workspaceId: "ws", githubLogin: "noah" }, { workspaceId: "ws", githubLogin: "apekshik" }],
    agents: [{ _id: "a1", workspaceId: "ws", handle: "claude", harness: "claude" }, { _id: "a2", workspaceId: "ws", handle: "codex", harness: "codex" }],
    chats: [{ _id: "chat", workspaceId: "ws", private: false, members: ["noah", "apekshik"], agents: null, pinnedAgent: null, state: "open" }],
    runs: [{ _id: "r0", chatId: "chat", agentId: "a2", workScope: "mac-a2-noah", state: "completed" }],
    changes: [{ _id: "c1", chatId: "chat", workspaceId: "ws", repo: "acme/beam", branch: "beam/x", state: "open", prNumber: 12, createdBy: "noah", syncGen: 1, workScope: "mac-a2-noah", headSha: "h1", headAt: 0 }],
  };
  let n = 0;
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    patch: async (id: string, patch: any) => {
      const row = await db.get(id);
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete row[k]; else row[k] = v;
    },
    insert: async (table: string, row: any) => { const _id = `${table}${++n}`; tables[table]!.push({ _id, ...row }); return _id; },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, unknown][] = [];
      const q = { eq: (key: string, value: unknown) => { filters.push([key, value]); return q; } };
      fn?.(q);
      const rows = () => tables[table]!.filter((row) => filters.every(([key, value]) => row[key] === value));
      return { collect: async () => rows(), first: async () => rows()[0] ?? null, order: () => ({ collect: async () => rows().reverse() }) };
    } }),
  };
  return { tables, change: tables.changes![0], ctx: { db, scheduler: { runAfter: vi.fn() } } };
}

const failing = { rollupState: "FAILURE", items: [{ name: "test", state: "failed" as const, url: null }, { name: "lint", state: "passed" as const, url: null }] };
const passing = { rollupState: "SUCCESS", items: [{ name: "test", state: "passed" as const, url: null }] };
const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN", merged: false, isDraft: false, title: "Add workspace deletion", url: "https://github.com/acme/beam/pull/12", additions: 1, deletions: 0, changedFiles: 1, headRefOid: "h1",
  author: "noah", openedAt: 1, mergeable: "MERGEABLE", reviewDecision: null, mergeMethod: "MERGE", comments: [], ...passing, ...over,
});
const comment = (id: string) => ({ id, path: "src/a.ts", line: 3, author: "apekshik", body: `please ${id}`, url: null });

beforeEach(() => { vi.mocked(sendAs).mockClear(); vi.mocked(chooseRunner).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

it("switches auto-fix on for the agent that made the PR, as the person who switched it", async () => {
  const { ctx, change } = fixture();
  await call(setAuto, ctx, { changeId: "c1", kind: "fix", on: true });
  expect(change.autoFix).toEqual({ by: "noah", agentId: "a2", attempts: 0, addressed: [] });
  expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce();
  await call(setAuto, ctx, { changeId: "c1", kind: "fix", on: false });
  expect(change.autoFix).toBeUndefined();
});

it("sends the agent at failing CI once per head, as whoever switched auto-fix on", async () => {
  const { ctx, change } = fixture();
  change.autoFix = { by: "apekshik", agentId: "a2", attempts: 0, addressed: [] };
  await call(applyPr, ctx, { changeId: "c1", pr: snap(failing), gen: 1 });
  expect(sendAs).toHaveBeenCalledOnce();
  const [, , login, args] = vi.mocked(sendAs).mock.calls[0]! as any[];
  expect(login).toBe("apekshik");
  expect(args).toMatchObject({ chatId: "chat", mentionHandle: "codex" });
  expect(args.text).toMatch(/^@codex CI is failing on acme\/beam#12 \(test\)\. Read the failing checks and push a fix\.\n\n\(Sent by auto-fix/);
  expect(change.autoFix).toMatchObject({ attempts: 1, sha: "h1" });

  await call(applyPr, ctx, { changeId: "c1", pr: snap(failing), gen: 1 });
  expect(sendAs).toHaveBeenCalledOnce();
  await call(applyPr, ctx, { changeId: "c1", pr: snap({ ...failing, headRefOid: "h2" }), gen: 1 });
  expect(sendAs).toHaveBeenCalledTimes(2);
});

it("sends new review comments once, and waits while an agent is working in the thread", async () => {
  const { ctx, change, tables } = fixture();
  change.autoFix = { by: "noah", agentId: "a1", attempts: 0, addressed: [] };
  tables.runs!.push({ _id: "r1", chatId: "chat", agentId: "a1", state: "working" });
  await call(applyPr, ctx, { changeId: "c1", pr: snap({ comments: [comment("t1")] }), gen: 1 });
  expect(sendAs).not.toHaveBeenCalled();

  tables.runs![1].state = "completed";
  await call(applyPr, ctx, { changeId: "c1", pr: snap({ comments: [comment("t1")] }), gen: 1 });
  expect((vi.mocked(sendAs).mock.calls[0]! as any[])[3].text).toContain("Address this review comment on acme/beam#12:\n- src/a.ts:3 (apekshik) please t1");
  expect(change.autoFix).toMatchObject({ attempts: 0, addressed: ["t1"] });
  await call(applyPr, ctx, { changeId: "c1", pr: snap({ comments: [comment("t1"), comment("t2")] }), gen: 1 });
  expect((vi.mocked(sendAs).mock.calls[1]! as any[])[3].text).not.toContain("t1");
});

it("says why auto-fix couldn't start, and stops after its last try at CI", async () => {
  const { ctx, change } = fixture();
  change.autoFix = { by: "noah", agentId: "a1", attempts: 0, addressed: [] };
  vi.mocked(chooseRunner).mockRejectedValueOnce(new Error("No online machine can run Claude Code"));
  await call(applyPr, ctx, { changeId: "c1", pr: snap(failing), gen: 1 });
  expect(sendAs).not.toHaveBeenCalled();
  expect(change.autoFix.note).toBe("Couldn't start @claude for noah: No online machine can run Claude Code");

  change.autoFix = { by: "noah", agentId: "a1", attempts: 3, sha: "h0", addressed: [] };
  await call(applyPr, ctx, { changeId: "c1", pr: snap(failing), gen: 1 });
  expect(sendAs).not.toHaveBeenCalled();
  expect(change.autoFix.note).toMatch(/^Stopped after 3 tries/);
});

it("hands a ready PR to the action to merge, and otherwise says what auto-merge waits for", async () => {
  const { ctx, change } = fixture();
  change.autoMerge = { by: "apekshik" };
  expect(await call(applyPr, ctx, { changeId: "c1", pr: snap({ reviewDecision: "REVIEW_REQUIRED" }), gen: 1 })).toEqual({ checks: "passing", merge: null });
  expect(change.autoMerge).toEqual({ by: "apekshik", note: "Waiting for a required review" });
  expect(await call(applyPr, ctx, { changeId: "c1", pr: snap({ mergeMethod: "SQUASH" }), gen: 1 })).toEqual({
    checks: "passing", merge: { login: "apekshik", repo: "acme/beam", prNumber: 12, sha: "h1", method: "squash" },
  });
});

it("gives a new head with no checks time for CI to register before merging", async () => {
  const { ctx, change } = fixture();
  change.autoMerge = { by: "apekshik" };
  const r = await call(applyPr, ctx, { changeId: "c1", pr: snap({ headRefOid: "h2", rollupState: null, items: [] }), gen: 1 });
  expect(r.merge).toBeNull();
  expect(change.autoMerge.note).toBe("Waiting for checks to start");
});

it("merges as the person who switched auto-merge on, naming the head it read", async () => {
  const { ctx, change } = fixture();
  change.autoMerge = { by: "apekshik" };
  const puts: any[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    if (url.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { viewerDefaultMergeMethod: "MERGE", pullRequest: {
      state: "OPEN", merged: false, isDraft: false, title: "t", url: "https://github.com/acme/beam/pull/12", additions: 1, deletions: 0, changedFiles: 1, headRefOid: "h1",
      mergeable: "MERGEABLE", reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }] },
    } } } }));
    puts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return puts.length === 1 ? new Response(JSON.stringify({ merged: true })) : new Response(JSON.stringify({ message: "Required status check \"e2e\" is expected." }), { status: 405 });
  });
  const actx = {
    runQuery: async (ref: any, args: any) => getFunctionName(ref) === "github:tokenOf" ? call(tokenOf, ctx, args) : call(openChangesWithTokens, ctx),
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "github:applyPr") return call(applyPr, ctx, args);
      if (name === "github:noteMerge") return call(noteMerge, ctx, args);
    },
  };
  await call(syncChanges, actx);
  expect(puts[0]).toEqual({ url: "https://api.github.com/repos/acme/beam/pulls/12/merge", auth: "Bearer ap-token", body: { sha: "h1", merge_method: "merge" } });
  expect(change.autoMerge).toEqual({ by: "apekshik" });
  expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce(); // read it back as merged

  await call(syncChanges, actx);
  expect(change.autoMerge.note).toBe("GitHub didn't merge it: Required status check \"e2e\" is expected.");
});

it("settles the thread when an auto-settle PR merges, unless another PR there is still open", async () => {
  const { ctx, change, tables } = fixture();
  change.autoSettle = { by: "noah" };
  tables.changes!.push({ _id: "c2", chatId: "chat", state: "open", prNumber: 13 });
  await call(applyPr, ctx, { changeId: "c1", pr: snap({ state: "MERGED", merged: true }), gen: 1 });
  expect(change.state).toBe("merged");
  expect(tables.chats![0].state).toBe("open");

  const again = fixture();
  again.change.autoSettle = { by: "noah" };
  await call(applyPr, again.ctx, { changeId: "c1", pr: snap({ state: "CLOSED" }), gen: 1 });
  expect(again.tables.chats![0]).toMatchObject({ state: "settled", settledAt: expect.any(Number) });
});
