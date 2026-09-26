import { describe, expect, it } from "vitest";
import { demoMatches, ensure, DEMO_LOGIN } from "./demo";

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
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, value: any) => { (tables[table] ??= []); const row = { _id: `${table}${tables[table].length}`, _creationTime: Date.now(), ...value }; tables[table].push(row); return row._id; },
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
