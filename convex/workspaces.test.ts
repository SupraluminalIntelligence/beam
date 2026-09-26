import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
import { mine, remove } from "./workspaces";

// The same in-memory Convex handler fixture used by the chats tests.
function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "alice" }],
    workspaces: [{ _id: "workspace", name: "Team", repos: [], createdBy: "user" }, { _id: "other", name: "Keep", repos: [], createdBy: "user" }],
    members: [{ _id: "m1", workspaceId: "workspace", githubLogin: "alice" }, { _id: "m2", workspaceId: "workspace", githubLogin: "bob" }, { _id: "m3", workspaceId: "other", githubLogin: "alice" }],
    chats: [{ _id: "chat", workspaceId: "workspace", title: "Work", private: false, members: ["alice"] }, { _id: "kept", workspaceId: "other", title: "Kept", private: false, members: ["alice"] }],
    runs: [], computeJobs: [], messages: [{ _id: "message", chatId: "chat", text: "Hello" }],
    workspaceResources: [{ _id: "res", workspaceId: "workspace", revoked: false }],
    presence: [{ _id: "p1", workspaceId: "workspace", githubLogin: "alice" }],
  };
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    patch: async (id: string, patch: any) => Object.assign(await db.get(id), patch),
    delete: async (id: string) => { for (const t of Object.values(tables)) { const i = t.findIndex(r => r._id === id); if (i >= 0) t.splice(i, 1); } },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, unknown][] = [];
      const q = { eq: (key: string, value: unknown) => { filters.push([key, value]); return q; } };
      fn(q);
      return { collect: async () => tables[table]!.filter(row => filters.every(([key, value]) => row[key] === value)) };
    } }),
  };
  return { tables, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

it("deletes the workspace for every member, keeping history", async () => {
  const { ctx, tables } = fixture();
  await call(remove, ctx, { workspaceId: "workspace" });
  expect((await call(mine, ctx, {})).map((w: any) => w.id)).toEqual(["other"]);
  expect(tables.members!.map(m => m._id)).toEqual(["m3"]);
  expect(tables.chats!.find(c => c._id === "chat").state).toBe("deleted");
  expect(tables.chats!.find(c => c._id === "kept").state).toBeUndefined();
  expect(tables.workspaceResources![0].revoked).toBe(true);
  expect(tables.presence).toHaveLength(0);
  expect(tables.messages).toHaveLength(1);
  expect(tables.workspaces![0].deletedAt).toEqual(expect.any(Number));
});

it("only lets the creator delete", async () => {
  const { ctx, tables } = fixture();
  tables.workspaces![0].createdBy = "someone-else";
  await expect(call(remove, ctx, { workspaceId: "workspace" })).rejects.toThrow("Only the person who created");
  tables.members = tables.members!.filter(m => m.workspaceId !== "workspace");
  await expect(call(remove, ctx, { workspaceId: "workspace" })).rejects.toThrow("not a member");
  expect(tables.workspaces![0].deletedAt).toBeUndefined();
});

it("blocks deletion while an agent or job is running", async () => {
  const { ctx, tables } = fixture();
  tables.runs = [{ chatId: "chat", state: "working" }];
  await expect(call(remove, ctx, { workspaceId: "workspace" })).rejects.toThrow("Stop the running agent");
  tables.runs = [];
  tables.computeJobs = [{ chatId: "chat", state: "running" }];
  await expect(call(remove, ctx, { workspaceId: "workspace" })).rejects.toThrow("Stop or cancel");
  expect(tables.chats![0].state).toBeUndefined();
  expect(tables.members).toHaveLength(3);
});
