import { expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
import { create } from "./chats";
import { send, startRun } from "./messages";
import { claim, muted, setMuted, followParticipant, notifyRun, resolveInputNotifications } from "./notifications";
function fixture(privateChat = false) {
  const tables: Record<string, any[]> = {
    runs: [{ _id: "run", chatId: "chat", agentId: "agent", dispatchedBy: "apek", runnerId: "george-machine" }],
    chats: [{ _id: "chat", workspaceId: "workspace", title: "Fix tests", private: privateChat, members: ["apek"] }],
    agents: [{ _id: "agent", harness: "codex" }],
    members: [{ workspaceId: "workspace", githubLogin: "apek" }, { workspaceId: "workspace", githubLogin: "george" }],
    chatFollowers: [{ chatId: "chat", login: "george" }, { chatId: "chat", login: "outsider" }, { chatId: "chat", login: "apek" }],
    workspaces: [{ _id: "workspace", repos: [] }], messages: [],
    users: [{ _id: "user", githubLogin: "apek" }, { githubLogin: "george" }], notifications: [],
  };
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, value: any) => { const row = { _id: `${table}${tables[table]!.length}`, ...value }; tables[table]!.push(row); return row._id; },
    patch: async (id: string, patch: any) => { Object.assign(await db.get(id), patch); },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, any][] = []; const q = { eq: (k: string, v: any) => { filters.push([k,v]); return q; } }; fn(q);
      const rows = () => tables[table]!.filter((r) => filters.every(([k,v]) => r[k] === v));
      return { collect: async () => rows(), first: async () => rows()[0] ?? null };
    } }),
  };
  return { tables, ctx: { db } as unknown as MutationCtx };
}
const runId = "run" as Id<"runs">;
it("notifies requester and followers, not the runner owner by default, and deduplicates retries", async () => {
  const { ctx, tables } = fixture();
  tables.chatFollowers = [];
  await notifyRun(ctx, runId, "completed", "ended"); await notifyRun(ctx, runId, "completed", "ended");
  expect(tables.notifications!.map((n) => n.recipient)).toEqual(["apek"]);
});
it("enforces membership and private chat access for followers", async () => {
  const team = fixture(); await notifyRun(team.ctx, runId, "completed", "ended");
  expect(team.tables.notifications!.map((n) => n.recipient)).toEqual(["apek", "george"]);
  const privateChat = fixture(true); await notifyRun(privateChat.ctx, runId, "completed", "ended");
  expect(privateChat.tables.notifications!.map((n) => n.recipient)).toEqual(["apek"]);
});
it("honors individual category preferences and clears resolved input alerts", async () => {
  const { ctx, tables } = fixture(); tables.users![1].notificationPreferences = { enabled: true, completed: false, failed: true, input: true, sound: false };
  await notifyRun(ctx, runId, "completed", "ended");
  expect(tables.notifications!.map((n) => n.recipient)).toEqual(["apek"]);
  await notifyRun(ctx, runId, "input", "input:q1"); await resolveInputNotifications(ctx, runId, "q1");
  expect(tables.notifications!.filter((n) => n.kind === "input").every((n) => n.readAt !== null && n.deliveredAt !== null)).toBe(true);
});

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
it("automatically follows chat creation and sending, but mere viewing does not subscribe", async () => {
  const { ctx, tables } = fixture();
  tables.chatFollowers = []; tables.agents = []; tables.runs = [];
  expect(await call(muted, ctx, { chatId: "chat" })).toBe(false);
  expect(tables.chatFollowers).toHaveLength(0);
  const chatId = await call(create, ctx, { workspaceId: "workspace", isPrivate: false });
  expect(tables.chatFollowers).toEqual([expect.objectContaining({ chatId, login: "apek" })]);
  await call(send, ctx, { chatId: "chat", text: "Hello", mentionHandle: null });
  await call(send, ctx, { chatId: "chat", text: "Again", mentionHandle: null });
  expect(tables.chatFollowers!.filter(f => f.chatId === "chat")).toHaveLength(1);
});
it("mute suppresses even the requester, survives participation, and unmute restores alerts", async () => {
  const { ctx, tables } = fixture();
  tables.chatFollowers = [];
  await call(setMuted, ctx, { chatId: "chat", muted: true });
  await followParticipant(ctx, "chat" as Id<"chats">, "apek");
  await notifyRun(ctx, runId, "completed", "ended");
  await notifyRun(ctx, runId, "failed", "failed");
  await notifyRun(ctx, runId, "input", "input:q1");
  expect(tables.notifications).toHaveLength(0);
  expect(await call(muted, ctx, { chatId: "chat" })).toBe(true);
  await call(setMuted, ctx, { chatId: "chat", muted: false });
  await notifyRun(ctx, runId, "completed", "ended");
  expect(tables.notifications!.map(n => n.recipient)).toEqual(["apek"]);
  expect(tables.chatFollowers).toHaveLength(1);
});
it("rechecks mute before claiming an already queued desktop banner", async () => {
  const { ctx, tables } = fixture(); tables.chatFollowers = [];
  await notifyRun(ctx, runId, "completed", "ended");
  const id = tables.notifications![0]._id;
  await call(setMuted, ctx, { chatId: "chat", muted: true });
  expect(await call(claim, ctx, { id })).toBe(false);
  expect(tables.notifications![0].readAt).toBeNull();
  await call(setMuted, ctx, { chatId: "chat", muted: false });
  expect(await call(claim, ctx, { id })).toBe(true);
  expect(await call(claim, ctx, { id })).toBe(false);
});
it("does not allow muting a chat without access", async () => {
  const { ctx, tables } = fixture(); tables.members = [];
  await expect(call(setMuted, ctx, { chatId: "chat", muted: true })).rejects.toThrow("not a member");
  tables.members = [{ workspaceId: "workspace", githubLogin: "apek" }];
  tables.chats![0].private = true; tables.chats![0].members = ["george"];
  await expect(call(setMuted, ctx, { chatId: "chat", muted: true })).rejects.toThrow("private chat");
});

it("subscribes the dispatcher even for runs started by the router", async () => {
  const { ctx, tables } = fixture(); tables.chatFollowers = [];
  tables.runners = [{ _id: "runner", name: "Local", ownerLogin: "apek", online: true, lastSeen: Date.now(), launchedByApp: true, harnesses: [{ harness: "claude", auth: "authenticated" }] }];
  tables.messages = [{ _id: "message", chatId: "chat", author: "apek" }];
  await startRun(ctx, tables.chats![0], { ...tables.agents![0], harness: "claude", model: "sonnet", effort: "high" }, "message" as Id<"messages">, "apek");
  expect(tables.chatFollowers).toEqual([expect.objectContaining({ chatId: "chat", login: "apek" })]);
});
