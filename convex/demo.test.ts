import { describe, expect, it } from "vitest";
import { demoMatches, ensure, reset, DEMO_LOGIN } from "./demo";

const env = { DEMO_EMAIL: "Review@Example.test", DEMO_PASSWORD: "correct horse battery" };

describe("demo sign-in", () => {
  it("is off unless both variables are set", () => {
    expect(demoMatches("review@example.test", "correct horse battery", {})).toBe(false);
    expect(demoMatches("review@example.test", "correct horse battery", { DEMO_EMAIL: env.DEMO_EMAIL })).toBe(false);
  });
  it("matches the email case-insensitively and the password exactly", () => {
    expect(demoMatches(" review@EXAMPLE.test ", "correct horse battery", env)).toBe(true);
    expect(demoMatches("review@example.test", "Correct horse battery", env)).toBe(false);
    expect(demoMatches("someone@example.test", "correct horse battery", env)).toBe(false);
    expect(demoMatches(undefined, "correct horse battery", env)).toBe(false);
  });
});

function fakeDb() {
  const tables: Record<string, any[]> = {};
  let clock = 1_000_000; // Convex stamps each insert a little later than the last
  const db = {
    delete: async (id: string) => { for (const t of Object.values(tables)) { const i = t.findIndex((r) => r._id === id); if (i >= 0) t.splice(i, 1); } },
    patch: async (id: string, patch: any) => { Object.assign(await db.get(id), patch); },
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, value: any) => { (tables[table] ??= []); const row = { _id: `${table}${tables[table].length}-${clock}`, _creationTime: (clock += 0.25), ...value }; tables[table].push(row); return row._id; },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, any][] = []; const q = { eq: (k: string, v: any) => { filters.push([k, v]); return q; } }; fn(q);
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      return { collect: async () => rows(), first: async () => rows()[0] ?? null };
    } }),
  };
  return { tables, ctx: { db } };
}

describe("demo workspace", () => {
  it("creates one user and one workspace, and signing in again changes nothing", async () => {
    const { tables, ctx } = fakeDb();
    const first = await (ensure as any)._handler(ctx, {});
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    const again = await (ensure as any)._handler(ctx, {});
    expect(again.userId).toBe(first.userId);
    expect(Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]))).toEqual(counts);
    expect(tables.workspaces).toHaveLength(1);
    expect(tables.users!.filter((u) => u.githubLogin === DEMO_LOGIN)).toHaveLength(1);
  });
  it("seeds only finished runs on an offline machine that cannot connect", async () => {
    const { tables, ctx } = fakeDb();
    await (ensure as any)._handler(ctx, {});
    expect(tables.runs!.every((r) => r.state === "landed")).toBe(true);
    expect(tables.runners![0]).toMatchObject({ online: false, ownerLogin: DEMO_LOGIN });
    expect(tables.runnerTokens![0].revokedAt).not.toBeNull();
    expect(tables.members!.map((m) => m.githubLogin)).toContain(DEMO_LOGIN);
  });
});

describe("demo timeline", () => {
  it("times each run's steps between its dispatch and its reply as stored", async () => {
    const { tables, ctx } = fakeDb();
    await (ensure as any)._handler(ctx, {});
    for (const run of tables.runs!) {
      const dispatch = tables.messages!.find((m) => m._id === run.dispatchMessageId)!;
      const reply = tables.messages!.find((m) => m.runId === run._id && m.kind === "report")!;
      const times = tables.runEvents!.filter((e) => e.runId === run._id).map((e) => e.event.at);
      expect(times.every((t: number) => t > dispatch._creationTime && t < reply._creationTime)).toBe(true);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
  it("reset rebuilds only the demo workspace and leaves everyone else alone", async () => {
    const { tables, ctx } = fakeDb();
    const other = await ctx.db.insert("workspaces", { name: "Real team", repos: [], createdBy: "someone" });
    await ctx.db.insert("members", { workspaceId: other, githubLogin: "apekshik", invitedBy: "someone" });
    await ctx.db.insert("chats", { workspaceId: other, title: "Real chat" });
    await (ensure as any)._handler(ctx, {});
    await (reset as any)._handler(ctx, {});
    expect(tables.workspaces!.map((w) => w.name).sort()).toEqual(["Beam Demo", "Real team"]);
    expect(tables.chats!.filter((c) => c.title === "Real chat")).toHaveLength(1);
    expect(tables.runners!).toHaveLength(1);
    expect(tables.users!.filter((u) => u.githubLogin === DEMO_LOGIN)).toHaveLength(1);
  });
});
