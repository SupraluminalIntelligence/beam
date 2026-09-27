import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { markTokenRejected, openChangesWithTokens, syncChanges } from "./github";
import { EXPIRED } from "./prStatus";

const call = (fn: any, ctx: any, args = {}) => fn._handler(ctx, args);

function fixture() {
  const users = [
    { _id: "u1", githubLogin: "creator", githubToken: "dead", githubRejectedToken: undefined as string | undefined },
    { _id: "u2", githubLogin: "teammate", githubToken: "alive", githubRejectedToken: undefined as string | undefined },
  ];
  const changes = [{ _id: "c1", state: "open", prNumber: 21, repo: "acme/beam", createdBy: "creator", workspaceId: "ws", syncGen: 3 }];
  const members = [{ workspaceId: "ws", githubLogin: "creator" }, { workspaceId: "ws", githubLogin: "teammate" }];
  const tables: Record<string, any[]> = { users, changes, members };
  const db = {
    patch: async (id: string, patch: object) => Object.assign(users.find((u) => u._id === id)!, patch),
    query: (table: string) => ({
      withIndex: (_: string, filter: (q: any) => any) => {
        const eq: Record<string, unknown> = {};
        filter({ eq: (k: string, v: unknown) => { eq[k] = v; } });
        const rows = tables[table]!.filter((r) => Object.entries(eq).every(([k, v]) => r[k] === v));
        return { first: async () => rows[0] ?? null, collect: async () => rows };
      },
    }),
  };
  return { users, db };
}

const pr = { data: { repository: { pullRequest: {
  state: "OPEN", merged: false, isDraft: true, title: "Renamed by an agent", url: "https://github.com/acme/beam/pull/21",
  additions: 1, deletions: 0, changedFiles: 1, headRefOid: "abc", commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
} } } };

afterEach(() => vi.unstubAllGlobals());

it("marks a token GitHub no longer accepts and reads the PR with a teammate's instead", async () => {
  const { users, db } = fixture();
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers["authorization"]!.replace("Bearer ", "");
    seen.push(token);
    return token === "alive" ? new Response(JSON.stringify(pr)) : new Response("", { status: 401 });
  });
  const applied: any[] = [];
  const errors: string[] = [];
  const ctx = {
    runQuery: async () => call(openChangesWithTokens, { db }),
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "github:markTokenRejected") return call(markTokenRejected, { db }, args);
      if (name === "github:applyPr") applied.push(args);
      if (name === "github:markSyncError") errors.push(args.error);
    },
  };

  await call(syncChanges, ctx);
  expect(seen).toEqual(["dead", "alive"]);
  expect(users[0]!.githubRejectedToken).toBe("dead");
  expect(applied[0]).toMatchObject({ changeId: "c1", gen: 3, pr: { title: "Renamed by an agent", isDraft: true } });
  expect(errors).toEqual([]);

  // The dead token is skipped from now on, until a sign-in stores a new one.
  seen.length = 0;
  await call(syncChanges, ctx);
  expect(seen).toEqual(["alive"]);
  users[0]!.githubToken = "fresh";
  expect((await call(openChangesWithTokens, { db }))[0].access.tokens.map((t: any) => t.login)).toEqual(["creator", "teammate"]);
});

it("says GitHub access expired, not that no one gave access, when the only token is dead", async () => {
  const { users, db } = fixture();
  users[1]!.githubToken = undefined as never;
  vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
  const errors: string[] = [];
  const ctx = {
    runQuery: async () => call(openChangesWithTokens, { db }),
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "github:markTokenRejected") return call(markTokenRejected, { db }, args);
      if (name === "github:markSyncError") errors.push(args.error);
    },
  };
  await call(syncChanges, ctx);
  await call(syncChanges, ctx); // second pass has no usable token left at all
  expect(errors).toEqual([EXPIRED, EXPIRED]);
});

it("only marks the token GitHub answered for, not one a sign-in has since replaced", async () => {
  const { users, db } = fixture();
  users[0]!.githubToken = "fresh";
  await call(markTokenRejected, { db }, { login: "creator", token: "dead" });
  expect(users[0]!.githubRejectedToken).toBeUndefined();
});
