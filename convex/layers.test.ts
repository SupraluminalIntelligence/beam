import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
import { approve, deny, mine, parseScopes, pending, poll, revoke, start } from "./layers";
import { approve as approveRunner } from "./runnerAuth";
import * as me from "./v1/me";
import * as workspaces from "./v1/workspaces";
import * as chats from "./v1/chats";
import * as messages from "./v1/messages";
import * as runs from "./v1/runs";
import * as changes from "./v1/changes";
import * as people from "./v1/people";
import * as inbox from "./v1/inbox";
import * as layers from "./v1/layers";
import { RESOURCES, type ResourceName } from "../packages/contracts/src/layer";

/** In-memory Convex: enough of ctx.db for these handlers, with equality indexes and creation order. */
function fixture() {
  let n = 0;
  const row = (r: any) => ({ _creationTime: ++n, ...r });
  const tables: Record<string, any[]> = {
    users: [row({ _id: "user", githubLogin: "alice", username: "Alice", image: "a.png" }), row({ _id: "u2", githubLogin: "bob" })],
    members: [row({ workspaceId: "ws", githubLogin: "alice" }), row({ workspaceId: "ws", githubLogin: "bob" }), row({ workspaceId: "other", githubLogin: "bob" })],
    workspaces: [row({ _id: "ws", name: "Beam", repos: ["o/beam"] }), row({ _id: "other", name: "Bob's", repos: [] })],
    agents: [row({ _id: "ag", workspaceId: "ws", harness: "claude", handle: "claude", model: "Fable 5.1", effort: "high", permissionMode: "ask", alwaysAllow: [], contextPolicy: "whole-chat" })],
    chats: [
      row({ _id: "team", workspaceId: "ws", title: "Team", untitled: false, private: false, members: ["alice"], agents: null, pinnedAgent: null, pinnedRunner: null, repo: "o/beam", activeBranch: null, createdBy: "alice", lastMessageAt: 10 }),
      row({ _id: "secret", workspaceId: "ws", title: "Bob's", untitled: false, private: true, members: ["bob"], agents: null, pinnedAgent: null, pinnedRunner: null, repo: null, activeBranch: null, createdBy: "bob", lastMessageAt: 20 }),
      row({ _id: "gone", workspaceId: "ws", title: "Gone", untitled: false, private: false, members: ["alice"], agents: null, pinnedAgent: null, pinnedRunner: null, repo: null, activeBranch: null, createdBy: "alice", lastMessageAt: 30, state: "deleted" }),
    ],
    messages: [row({ _id: "m1", chatId: "team", author: "alice", kind: "dispatch", text: "@claude fix it", runId: "r1", reactions: [] }),
      row({ _id: "m2", chatId: "team", author: "agent:ag", kind: "report", text: "On it", runId: "r1", turn: 1, reactions: [{ emoji: "👍", by: ["alice"] }] })],
    runners: [row({ _id: "rn", name: "Mac mini" })],
    runs: [
      row({ _id: "r0", chatId: "team", agentId: "ag", runnerId: "rn", dispatchedBy: "alice", dispatchMessageId: "m1", state: "landed", branch: "b", worktree: "/Users/alice/.beam/wt", resumeCursor: { session: "s" }, landing: { repos: [], error: null }, startedAt: 1, endedAt: 2 }),
      row({ _id: "r1", chatId: "team", agentId: "ag", runnerId: "rn", dispatchedBy: "alice", dispatchMessageId: "m1", state: "working", branch: null, worktree: "/Users/alice/.beam/wt", resumeCursor: null, landing: null, startedAt: 3, endedAt: null, openRequests: ["q1"],
        execution: { model: "fable", modelName: "Fable 5.1", effort: "high", accountOwner: "alice", accountEmail: "alice@example.com", accountPlan: "Max", machineName: "Studio" } }),
      row({ _id: "r2", chatId: "secret", agentId: "ag", runnerId: "rn", dispatchedBy: "bob", dispatchMessageId: "m1", state: "working", branch: null, worktree: null, resumeCursor: null, landing: null, startedAt: 3, endedAt: null }),
    ],
    runEvents: [
      row({ runId: "r1", seq: 0, event: { type: "session.started", runId: "r1", resumeCursor: { session: "secret" } } }),
      row({ runId: "r1", seq: 1, event: { type: "account.updated", runId: "r1", plan: "Max", email: "alice@example.com" } }),
      row({ runId: "r1", seq: 2, event: { type: "turn.started", runId: "r1", turnId: "t1", at: 5 } }),
    ],
    changes: [row({ _id: "c1", chatId: "team", workspaceId: "ws", repo: "o/beam", branch: "b", base: "main", state: "open", title: "Fix", prUrl: null, prNumber: null, add: 1, del: 0, files: 1, adopted: false, createdBy: "alice", updatedAt: 4, resolvedAt: null, syncGen: 3, workScope: "x" })],
    presence: [row({ _id: "p1", workspaceId: "ws", githubLogin: "alice", focusedChat: "team", updatedAt: Date.now() }), row({ _id: "p2", workspaceId: "ws", githubLogin: "bob", focusedChat: "secret", updatedAt: Date.now() })],
    typing: [row({ chatId: "team", login: "bob", session: "s", expiresAt: 99 })],
    notifications: [row({ _id: "n1", recipient: "alice", chatId: "team", workspaceId: "ws", runId: "r1", kind: "input", title: "Asks", body: "q", readAt: null, deliveredAt: null }),
      row({ _id: "n2", recipient: "alice", chatId: "secret", workspaceId: "ws", kind: "mention", title: "old", body: "", readAt: null, deliveredAt: null })],
    computeJobs: [], deviceCodes: [], layerTokens: [], runnerTokens: [],
  };
  const all = () => Object.values(tables).flat();
  const db: any = {
    get: async (id: string) => all().find((r) => r._id === id) ?? null,
    insert: async (table: string, doc: any) => { const id = `${table}:${++n}`; (tables[table] ??= []).push(row({ _id: id, ...doc })); return id; },
    patch: async (id: string, patch: any) => { Object.assign(await db.get(id), patch); },
    delete: async (id: string) => { for (const t of Object.values(tables)) { const i = t.findIndex((r) => r._id === id); if (i >= 0) t.splice(i, 1); } },
    query: (table: string) => {
      let filters: [string, unknown][] = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      const ordered = (desc: boolean) => ({ first: async () => (desc ? rows().reverse() : rows())[0] ?? null, take: async (k: number) => (desc ? rows().reverse() : rows()).slice(0, k), collect: async () => desc ? rows().reverse() : rows() });
      return {
        withIndex: (_: string, fn: any) => {
          filters = [];
          const q = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } };
          fn(q);
          return { ...ordered(false), order: (o: string) => ordered(o === "desc") };
        },
      };
    },
  };
  return { tables, ctx: { db, scheduler: { runAfter: vi.fn() } }, queryCtx: { db } };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

async function connect(f: ReturnType<typeof fixture>, scopes = ["read"]) {
  const { deviceCode, userCode } = await call(start, f.ctx, { name: "Hamster office", hostname: "laptop", scopes });
  await call(approve, f.ctx, { userCode });
  const r = await call(poll, f.ctx, { deviceCode });
  return r.token as string;
}

it("issues a token only after the person approves the scopes the layer asked for", async () => {
  const f = fixture();
  const { deviceCode, userCode } = await call(start, f.ctx, { name: "Hamster office", hostname: "laptop", scopes: ["read"] });
  expect(await call(poll, f.ctx, { deviceCode })).toEqual({ status: "pending" });
  expect(await call(pending, f.queryCtx, { userCode: userCode.toLowerCase() })).toMatchObject({ name: "Hamster office", scopes: ["read"] });
  await expect(call(approveRunner, f.ctx, { userCode })).rejects.toThrow("Connected apps");
  await call(approve, f.ctx, { userCode });
  const r = await call(poll, f.ctx, { deviceCode });
  expect(r).toMatchObject({ status: "approved", githubLogin: "alice", scopes: ["read"] });
  expect(r.token).toMatch(/^blt_[0-9a-f]{64}$/);
  expect(f.tables.layerTokens![0].tokenHash).not.toBe(r.token);
  expect(await call(poll, f.ctx, { deviceCode })).toEqual({ status: "unknown" });
  expect(await call(me.get, f.queryCtx, { token: r.token })).toEqual({ login: "alice", name: "Alice", image: "a.png", layer: { name: "Hamster office", scopes: ["read"] } });
});

it("tells a denied layer so, and never mints a token for it", async () => {
  const f = fixture();
  const { deviceCode, userCode } = await call(start, f.ctx, { name: "x", hostname: "", scopes: ["read"] });
  await call(deny, f.ctx, { userCode });
  await expect(call(approve, f.ctx, { userCode })).rejects.toThrow("not waiting");
  expect(await call(poll, f.ctx, { deviceCode })).toEqual({ status: "denied" });
  expect(f.tables.layerTokens).toHaveLength(0);
});

it("refuses unknown scopes instead of quietly narrowing them", () => {
  expect(parseScopes(undefined)).toEqual(["read"]);
  expect(parseScopes(["read", "read"])).toEqual(["read"]);
  expect(parseScopes(["chat:write"])).toEqual(["read", "chat:write"]);
  expect(() => parseScopes(["read", "admin"])).toThrow('unknown scope "admin"');
});

it("stops working the moment it is revoked", async () => {
  const f = fixture();
  const token = await connect(f);
  const [t] = await call(mine, f.queryCtx, {});
  expect(t).toMatchObject({ name: "Hamster office", scopes: ["read"], revokedAt: null });
  await call(revoke, f.ctx, { id: t.id });
  await expect(call(me.get, f.queryCtx, { token })).rejects.toThrow("invalid or revoked");
  await expect(call(me.get, f.queryCtx, { token: "blt_forged" })).rejects.toThrow("invalid or revoked");
});

it("lets a layer sign itself out, and nothing else", async () => {
  const f = fixture();
  const a = await connect(f), b = await connect(f);
  await call(me.revoke, f.ctx, { token: a });
  await expect(call(me.get, f.queryCtx, { token: a })).rejects.toThrow("invalid or revoked");
  expect((await call(me.get, f.queryCtx, { token: b })).login).toBe("alice");
});

it("sees what the person sees: no private chats of others, no deleted chats, no other workspaces", async () => {
  const f = fixture();
  const token = await connect(f);
  expect((await call(workspaces.list, f.queryCtx, { token })).map((w: any) => w.id)).toEqual(["ws"]);
  await expect(call(workspaces.get, f.queryCtx, { token, workspaceId: "other" })).rejects.toThrow("not a member");
  expect((await call(chats.list, f.queryCtx, { token, workspaceId: "ws" })).map((c: any) => c.id)).toEqual(["team"]);
  await expect(call(messages.list, f.queryCtx, { token, chatId: "secret" })).rejects.toThrow("private chat");
  await expect(call(chats.get, f.queryCtx, { token, chatId: "gone" })).rejects.toThrow("no such chat");
  await expect(call(runs.events, f.queryCtx, { token, runId: "r2" })).rejects.toThrow("private chat");
  expect(await call(people.presence, f.queryCtx, { token, workspaceId: "ws" })).toEqual([{ login: "alice", chatId: "team", layer: null }, { login: "bob", chatId: null, layer: null }]);
  expect((await call(runs.active, f.queryCtx, { token, workspaceId: "ws" })).live.map((r: any) => r.id)).toEqual(["r1"]);
  expect((await call(inbox.list, f.queryCtx, { token })).map((n: any) => n.id)).toEqual(["n1"]);
});

it("keeps machine paths, resume cursors and provider accounts out of every answer", async () => {
  const f = fixture();
  const token = await connect(f);
  const out = JSON.stringify([
    await call(runs.list, f.queryCtx, { token, chatId: "team" }),
    await call(runs.eventsForChat, f.queryCtx, { token, chatId: "team" }),
    await call(runs.active, f.queryCtx, { token, workspaceId: "ws" }),
  ]);
  for (const secret of ["/Users/alice", "alice@example.com", "secret", "Max", "accountOwner", "worktree", "resumeCursor\":{"]) expect(out).not.toContain(secret);
  expect(await call(runs.events, f.queryCtx, { token, runId: "r1" })).toEqual([
    { type: "session.started", runId: "r1", resumeCursor: null },
    { type: "turn.started", runId: "r1", turnId: "t1", at: 5 },
  ]);
});

it("answers every resource in the shape the contract promises", async () => {
  const f = fixture();
  const token = await connect(f);
  const fns: Record<ResourceName, [any, any]> = {
    "me.get": [me.get, {}], "workspaces.list": [workspaces.list, {}], "workspaces.get": [workspaces.get, { workspaceId: "ws" }],
    "chats.list": [chats.list, { workspaceId: "ws" }], "chats.get": [chats.get, { chatId: "team" }], "chats.activity": [chats.activity, { workspaceId: "ws" }],
    "messages.list": [messages.list, { chatId: "team" }], "runs.list": [runs.list, { chatId: "team" }], "runs.active": [runs.active, { workspaceId: "ws" }],
    "runs.events": [runs.events, { runId: "r1" }], "runs.eventsForChat": [runs.eventsForChat, { chatId: "team" }], "changes.list": [changes.list, { chatId: "team" }],
    "people.presence": [people.presence, { workspaceId: "ws" }], "people.typing": [people.typing, { chatId: "team" }], "inbox.list": [inbox.list, {}],
    "layers.state": [layers.state, { workspaceId: "ws", layer: "office" }],
  };
  for (const [name, [fn, args]] of Object.entries(fns) as [ResourceName, [any, any]][]) {
    expect(Object.keys(args).sort(), name).toEqual([...RESOURCES[name].args].sort());
    const value = await call(fn, f.queryCtx, { token, ...args });
    const strict = (RESOURCES[name].returns as any).safeParse(value);
    expect(strict.success, `${name}: ${JSON.stringify(strict.error?.issues)}`).toBe(true);
  }
  expect(await call(chats.activity, f.queryCtx, { token, workspaceId: "ws" })).toEqual({ team: "ask" });
  expect((await call(messages.list, f.queryCtx, { token, chatId: "team" }))[1]).toMatchObject({ author: { type: "agent", agentId: "ag" }, turn: 1 });
  expect((await call(runs.list, f.queryCtx, { token, chatId: "team" })).find((r: any) => r.id === "r1")).toMatchObject({ machine: "Studio", model: "Fable 5.1", openRequests: ["q1"] });
});

const ALL = ["read", "chat:write", "run:respond", "run:interrupt", "presence:write", "layer:state"];

it("does nothing a token was not approved for", async () => {
  const f = fixture();
  const token = await connect(f);
  await expect(call(messages.send, f.ctx, { token, chatId: "team", text: "hi" })).rejects.toThrow("may not chat:write");
  await expect(call(messages.react, f.ctx, { token, messageId: "m1", emoji: "👍" })).rejects.toThrow("may not chat:write");
  await expect(call(runs.respond, f.ctx, { token, runId: "r1", requestId: "q1", decision: "allow" })).rejects.toThrow("may not run:respond");
  await expect(call(runs.interrupt, f.ctx, { token, runId: "r1" })).rejects.toThrow("may not run:interrupt");
  await expect(call(people.focus, f.ctx, { token, workspaceId: "ws", chatId: "team" })).rejects.toThrow("may not presence:write");
  await expect(call(layers.set, f.ctx, { token, workspaceId: "ws", layer: "office", scope: "person", data: {} })).rejects.toThrow("may not layer:state");
  expect(f.tables.messages).toHaveLength(2);
});

it("posts as the person, and an @mention of an agent in the chat dispatches it like the composer does", async () => {
  const f = fixture();
  const token = await connect(f, ALL);
  const r = await call(messages.send, f.ctx, { token, chatId: "team", text: "  morning all " });
  expect(r).toMatchObject({ kind: "text", runner: null });
  expect(f.tables.messages!.at(-1)).toMatchObject({ author: "alice", kind: "text", text: "morning all" });
  // An agent was mentioned: the same path the composer takes. Alice's live run with it hears it as a steer...
  expect(await call(messages.send, f.ctx, { token, chatId: "team", text: "hey @Claude can you look" })).toMatchObject({ kind: "steer" });
  expect(f.tables.messages!.at(-1)).toMatchObject({ kind: "steer", runId: "r1" });
  // ...and with no live run it dispatches a new one, which needs a machine to host it.
  f.tables.runs![1].state = "landed";
  await expect(call(messages.send, f.ctx, { token, chatId: "team", text: "@claude again" })).rejects.toThrow("Settings → Models & accounts");
  expect(f.tables.messages!.at(-1)).toMatchObject({ kind: "steer" });
  await expect(call(messages.send, f.ctx, { token, chatId: "team", text: "x", mention: "nobody" })).rejects.toThrow("no agent @nobody");
  await expect(call(messages.send, f.ctx, { token, chatId: "secret", text: "hi" })).rejects.toThrow("private chat");
});

it("toggles reactions and answers only open questions, once", async () => {
  const f = fixture();
  const token = await connect(f, ALL);
  await call(messages.react, f.ctx, { token, messageId: "m1", emoji: "🎉" });
  expect(f.tables.messages![0].reactions).toEqual([{ emoji: "🎉", by: ["alice"] }]);
  await call(messages.react, f.ctx, { token, messageId: "m1", emoji: "🎉" });
  expect(f.tables.messages![0].reactions).toEqual([]);
  await expect(call(runs.respond, f.ctx, { token, runId: "r1", requestId: "q9", decision: "allow" })).rejects.toThrow("not open");
  await call(runs.respond, f.ctx, { token, runId: "r1", requestId: "q1", decision: "allow" });
  expect(f.tables.runEvents!.at(-1)!.event).toEqual({ type: "request.resolved", runId: "r1", requestId: "q1", by: "alice", decision: "allow" });
  expect(f.tables.runs!.find((r) => r._id === "r1").openRequests).toEqual([]);
  await expect(call(runs.respond, f.ctx, { token, runId: "r2", requestId: "q1", decision: "allow" })).rejects.toThrow("private chat");
});

it("stops live runs only", async () => {
  const f = fixture();
  const token = await connect(f, ALL);
  await call(runs.interrupt, f.ctx, { token, runId: "r0" });
  expect(f.tables.runs![0].interruptRequestedAt).toBeUndefined();
  await call(runs.interrupt, f.ctx, { token, runId: "r1" });
  expect(f.tables.runs![1].interruptRequestedAt).toBeTypeOf("number");
});

it("moves a person between chats and says which layer they are in; the plain apps clear it", async () => {
  const f = fixture();
  const token = await connect(f, ALL);
  await call(people.focus, f.ctx, { token, workspaceId: "ws", chatId: "team", layer: "hamster-office" });
  expect((await call(people.presence, f.queryCtx, { token, workspaceId: "ws" }))[0]).toEqual({ login: "alice", chatId: "team", layer: "hamster-office" });
  await expect(call(people.focus, f.ctx, { token, workspaceId: "ws", chatId: "team", layer: "Hamster Office" })).rejects.toThrow("layer id");
  await expect(call(people.focus, f.ctx, { token, workspaceId: "other", chatId: "team" })).rejects.toThrow("not a member");
  await expect(call(people.focus, f.ctx, { token, workspaceId: "ws", chatId: "secret" })).rejects.toThrow("private chat");
  const { focus: plainFocus } = await import("./presence");
  await call(plainFocus, f.ctx, { workspaceId: "ws", chatId: null });
  expect((await call(people.presence, f.queryCtx, { token, workspaceId: "ws" }))[0]).toEqual({ login: "alice", chatId: null, layer: null });
});

it("keeps a layer's own state per person, per chat and per workspace, within limits", async () => {
  const f = fixture();
  const token = await connect(f, ALL);
  const set = (args: any) => call(layers.set, f.ctx, { token, workspaceId: "ws", layer: "office", ...args });
  await set({ scope: "person", data: { room: "team", x: 3, y: 4 } });
  await set({ scope: "chat", chatId: "team", data: { desks: 4 } });
  await set({ scope: "workspace", data: { theme: "hamsters" } });
  f.tables.layerState!.push({ _id: "ls-bob", _creationTime: 0, workspaceId: "ws", layer: "office", scope: "chat", chatId: "secret", login: null, data: { hidden: true }, updatedBy: "bob", updatedAt: 1 });
  const s = await call(layers.state, f.queryCtx, { token, workspaceId: "ws", layer: "office" });
  expect(s.people).toEqual([{ login: "alice", data: { room: "team", x: 3, y: 4 }, updatedAt: expect.any(Number) }]);
  expect(s.chats.map((c: any) => c.chatId)).toEqual(["team"]);
  expect(s.workspace).toMatchObject({ data: { theme: "hamsters" }, updatedBy: "alice" });
  expect((await call(layers.state, f.queryCtx, { token, workspaceId: "ws", layer: "garden" })).people).toEqual([]);

  await expect(set({ scope: "person", data: { x: 5 } })).rejects.toThrow("too many writes");
  f.tables.layerState!.find((r) => r.scope === "person").updatedAt -= 1000;
  await set({ scope: "person", data: { x: 5 } });
  expect(f.tables.layerState!.filter((r) => r.scope === "person")).toHaveLength(1);
  await expect(set({ scope: "person", data: "x".repeat(5000) })).rejects.toThrow("at most 4096 bytes");
  await expect(set({ scope: "chat", chatId: "secret", data: {} })).rejects.toThrow("private chat");
  await expect(set({ scope: "chat", data: {} })).rejects.toThrow("needs a chatId");
  await expect(set({ scope: "room", data: {} })).rejects.toThrow("scope is");
  await expect(call(layers.set, f.ctx, { token, workspaceId: "ws", layer: "../x", scope: "person", data: {} })).rejects.toThrow("layer id");
  await set({ scope: "workspace", data: null });
  expect((await call(layers.state, f.queryCtx, { token, workspaceId: "ws", layer: "office" })).workspace).toBeNull();
});
