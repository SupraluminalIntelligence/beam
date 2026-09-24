import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
vi.mock("./notifications", () => ({ followParticipant: async () => {}, notifyMentions: async () => {} }));
import { preview, setPreference, preferences } from "./connections";
import { send } from "./messages";
import { claim } from "./runs";
import { sha256 } from "./runnerAuth";
import { hello, mine, nameForRun, rename } from "./runners";

function fixture() {
  const status = { harness: "claude", auth: "authenticated", connectionId: "default", connectionName: "Personal", isDefault: true, email: "apex@example.test", plan: "Max" };
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "apex" }],
    chats: [{ _id: "chat", workspaceId: "workspace", title: "Work", members: ["apex", "noah"], private: false, activeBranch: null, autoRoute: false }],
    members: [{ workspaceId: "workspace", githubLogin: "apex" }, { workspaceId: "workspace", githubLogin: "noah" }],
    agents: [{ _id: "agent", workspaceId: "workspace", harness: "claude", handle: "claude", model: "opus", effort: "high" }],
    runners: ["personal", "work"].map(id => ({ _id: id, name: id, ownerLogin: "apex", online: true, lastSeen: Date.now(), harnesses: [{ ...status, email: `${id}@example.test` }] })),
    runs: [], messages: [],
  };
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    patch: async (id: string, patch: any) => Object.assign(await db.get(id), patch),
    insert: async (table: string, value: any) => { const id = `${table}-${tables[table]!.length}`; tables[table]!.push({ _id: id, ...value }); return id; },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, unknown][] = [];
      const q = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } }; fn(q);
      const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => r[k] === v));
      return { collect: async () => rows(), first: async () => rows()[0] ?? null };
    } }),
  };
  return { tables, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const args = { chatId: "chat", harness: "claude", localRunnerId: "personal" };

it("keeps machine aliases across restarts and resolves them for existing run details", async () => {
  const { ctx, tables } = fixture();
  tables.runners![0].tokenId = "token-id";
  tables.runnerTokens = [{ _id: "token-id", tokenHash: await sha256("runner-token"), githubLogin: "apex", revokedAt: null }];
  await call(send, ctx, { chatId: "chat", text: "@claude inspect", mentionHandle: "claude", localRunnerId: "personal" });
  const run = tables.runs![0];
  await call(rename, ctx, { runnerId: "personal", name: "  Apek’s MacBook Pro  " });
  expect((await call(preview, ctx, args)).selected.machineName).toBe("Apek’s MacBook Pro");
  await call(hello, ctx, { token: "runner-token", name: "system-name", hostname: "host.local", platform: "darwin", harnesses: [], launchedByApp: true });
  expect((await call(mine, ctx, {}))[0].name).toBe("Apek’s MacBook Pro");
  expect(await call(nameForRun, ctx, { runId: run._id })).toBe("Apek’s MacBook Pro");
  expect(run.execution.machineName).toBe("personal"); // Preserve the historical record.
});
it("restricts renaming to the machine owner and run names to chat members", async () => {
  const { ctx, tables } = fixture();
  tables.runners![1].ownerLogin = "noah";
  await expect(call(rename, ctx, { runnerId: "work", name: "Other machine" })).rejects.toThrow("Not your machine");
  for (const name of ["  ", "x".repeat(81), "two\nlines"]) await expect(call(rename, ctx, { runnerId: "personal", name })).rejects.toThrow("Use a name");
  tables.runs!.push({ _id: "private-run", chatId: "chat", runnerId: "work" });
  Object.assign(tables.chats![0], { private: true, members: ["noah"] });
  await expect(call(nameForRun, ctx, { runId: "private-run" })).rejects.toThrow("private chat");
});

it("uses chat override, then global account, then current-machine default", async () => {
  const { ctx, tables } = fixture();
  expect((await call(preview, ctx, args)).selected.runnerId).toBe("personal");
  await call(setPreference, ctx, { harness: "claude", runnerId: "work" });
  expect((await call(preview, ctx, args)).selected).toMatchObject({ runnerId: "work", remote: true, source: "global" });
  await call(setPreference, ctx, { harness: "claude", chatId: "chat", runnerId: "personal" });
  expect((await call(preview, ctx, args)).selected.source).toBe("chat");
  await call(setPreference, ctx, { harness: "claude", chatId: "chat" });
  expect((await call(preview, ctx, args)).selected.runnerId).toBe("work");
  await call(setPreference, ctx, { harness: "claude" });
  expect((await call(preview, ctx, args)).selected.runnerId).toBe("personal");
  expect(tables.users![0].accountPreferences).toEqual([{ harness: "claude" }]);
});
it("freezes the reviewed account and host on a run and rejects changed previews", async () => {
  const { ctx, tables } = fixture();
  const selected = (await call(preview, ctx, args)).selected;
  await call(send, ctx, { chatId: "chat", text: "@claude inspect", mentionHandle: "claude", localRunnerId: "personal", expectedConnection: selected.key });
  expect(tables.runs![0].execution).toMatchObject({ machineName: "personal", connectionId: "default", accountEmail: "personal@example.test" });
  tables.runs![0].state = "landed";
  tables.runners![0].harnesses[0].email = "changed@example.test";
  await expect(call(send, ctx, { chatId: "chat", text: "@claude next", mentionHandle: "claude", localRunnerId: "personal", expectedConnection: selected.key })).rejects.toThrow("connection changed");
  expect(tables.runs).toHaveLength(1);
});
it("allows the same harness to run for two owners without steering the other owner's run", async () => {
  const { ctx, tables } = fixture();
  tables.runs!.push({ _id: "noahs-run", chatId: "chat", agentId: "agent", dispatchedBy: "noah", runnerId: "work", state: "working" });
  const result = await call(send, ctx, { chatId: "chat", text: "@claude review", mentionHandle: "claude", localRunnerId: "personal" });
  expect(result.kind).toBe("dispatch"); expect(tables.runs).toHaveLength(2);
  const steer = await call(send, ctx, { chatId: "chat", text: "@claude more", mentionHandle: "claude", localRunnerId: "work" });
  expect(steer.kind).toBe("steer"); expect(tables.messages!.at(-1).runId).toBe(tables.runs![1]._id);
  const explicit = await call(send, ctx, { chatId: "chat", text: "Check this too", mentionHandle: null, targetRunId: "noahs-run" });
  expect(explicit.kind).toBe("steer"); expect(tables.messages!.at(-1).runId).toBe("noahs-run");
});
it("does not expose or select another member's unshared account", async () => {
  const { ctx, tables } = fixture();
  tables.runners![1].ownerLogin = "noah";
  expect((await call(preview, ctx, args)).options).toHaveLength(1);
  await expect(call(setPreference, ctx, { harness: "claude", runnerId: "work" })).rejects.toThrow("not shared");
  tables.runners![1].allowSharedRuns = true;
  await call(setPreference, ctx, { harness: "claude", runnerId: "work" });
  tables.runners![1].allowSharedRuns = false;
  expect((await call(preview, ctx, args)).error).toContain("no longer shared");
});

it("displays migrated preferences and preserves unavailable chat overrides", async () => {
  const { ctx, tables } = fixture();
  tables.users![0].agentPreferences = [{ harness: "claude", runnerId: "work", model: "opus", effort: "high" }];
  expect((await call(preferences, ctx, {}))[0].runnerId).toBe("work");
  await call(setPreference, ctx, { harness: "claude", chatId: "chat", runnerId: "work" });
  tables.runners![1].online = false;
  const state = await call(preview, ctx, args);
  expect(state.selected).toBeNull();
  expect(state.override.runnerId).toBe("work");
  expect(state.error).toContain("offline");
});

it("requires a runner to acknowledge its isolated work scope before executing", async () => {
  const { ctx, tables } = fixture();
  tables.runners![0].tokenId = "token-id";
  tables.runnerTokens = [{ _id: "token-id", tokenHash: await sha256("runner-token"), revokedAt: null }];
  await call(send, ctx, { chatId: "chat", text: "@claude inspect", mentionHandle: "claude", localRunnerId: "personal" });
  const run = tables.runs![0];
  const args = { token: "runner-token", runId: run._id, branch: null, worktree: "/isolated" };
  await expect(call(claim, ctx, args)).rejects.toThrow("Update and restart");
  expect(run.state).toBe("queued");
  await call(claim, ctx, { ...args, workScope: run.workScope });
  expect(run.state).toBe("working");
});

it("blocks legacy runners before dispatch can alter a shared checkout", async () => {
  const { ctx, tables } = fixture();
  delete tables.runners![0].harnesses[0].connectionId;
  expect((await call(preview, ctx, args)).error).toContain("Update and restart");
  await expect(call(send, ctx, { chatId: "chat", text: "@claude inspect", mentionHandle: "claude", localRunnerId: "personal" })).rejects.toThrow("Update and restart");
  expect(tables.runs).toHaveLength(0);
});
