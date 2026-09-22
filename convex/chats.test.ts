import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
import { list, remove, setState } from "./chats";
import { send } from "./messages";
import { apply, context } from "./router";

// The same in-memory Convex handler fixture used by files/notifications tests.
function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "alice" }],
    members: [{ workspaceId: "workspace", githubLogin: "alice" }],
    chats: [{ _id: "chat", workspaceId: "workspace", title: "Delete me", private: false, members: ["alice"], lastMessageAt: 1 },
      { _id: "other", workspaceId: "workspace", title: "Keep me", private: false, members: ["alice"], lastMessageAt: 2 }],
    runs: [], computeJobs: [], messages: [{ _id: "message", chatId: "chat", kind: "text", text: "Hello", author: "alice" }],
  };
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    patch: async (id: string, patch: any) => Object.assign(await db.get(id), patch),
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, unknown][] = [];
      const q = { eq: (key: string, value: unknown) => { filters.push([key, value]); return q; } };
      fn(q);
      return { collect: async () => tables[table]!.filter(row => filters.every(([key, value]) => row[key] === value)) };
    } }),
  };
  return { tables, queryCtx: { db }, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

it("removes only the selected chat from workspace lists, retaining its history", async () => {
  const { ctx, queryCtx, tables } = fixture();
  await call(remove, ctx, { chatId: "chat" });
  expect((await call(list, queryCtx, { workspaceId: "workspace" })).map((c: any) => c._id)).toEqual(["other"]);
  expect(tables.chats![0].state).toBe("deleted");
  expect(tables.messages).toHaveLength(1);
});

it("requires workspace and private-chat access", async () => {
  const { ctx, tables } = fixture();
  tables.members = [];
  await expect(call(remove, ctx, { chatId: "chat" })).rejects.toThrow("not a member");
  tables.members = [{ workspaceId: "workspace", githubLogin: "alice" }];
  Object.assign(tables.chats![0], { private: true, members: ["bob"] });
  await expect(call(remove, ctx, { chatId: "chat" })).rejects.toThrow("private chat");
  expect(tables.chats![0].state).toBeUndefined();
});

it.each(["queued", "starting", "working", "landing"])("blocks deletion during a %s agent run", async state => {
  const { ctx, tables } = fixture();
  tables.runs = [{ chatId: "chat", state }];
  await expect(call(remove, ctx, { chatId: "chat" })).rejects.toThrow("Stop the running agent");
  expect(tables.chats![0].state).toBeUndefined();
});

it.each(["awaiting-approval", "queued", "preparing", "running", "publishing"])("blocks deletion during a %s compute job", async state => {
  const { ctx, tables } = fixture();
  tables.computeJobs = [{ chatId: "chat", state }];
  await expect(call(remove, ctx, { chatId: "chat" })).rejects.toThrow("Stop or cancel");
  expect(tables.chats![0].state).toBeUndefined();
});

it("allows finished work and prevents stale clients or delayed routing from reopening a deleted chat", async () => {
  const { ctx, queryCtx, tables } = fixture();
  tables.runs = [{ chatId: "chat", state: "completed" }];
  tables.computeJobs = [{ chatId: "chat", state: "succeeded" }];
  await call(remove, ctx, { chatId: "chat" });
  await expect(call(send, ctx, { chatId: "chat", text: "Hello", mentionHandle: null })).rejects.toThrow("deleted");
  await expect(call(setState, ctx, { chatId: "chat", state: "open" })).rejects.toThrow("deleted");
  expect(await call(context, queryCtx, { messageId: "message" })).toBeNull();
  await call(apply, ctx, { messageId: "message", agent: "codex", why: "scheduled earlier" });
  expect(tables.runs).toHaveLength(1);
  expect(tables.chats![0].state).toBe("deleted");
});
