import { expect, it } from "vitest";
import type { Chat, ChatSnapshot, LayerEvent, Message, Run, WorkspaceState } from "@beam/contracts/layer";
import { Beam, type Transport } from "./client.ts";
import { diffChat, diffWorkspace } from "./diff.ts";
import { chatTimeline, openRequests } from "./views.ts";

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId: "ws", title: id, untitled: false, private: false, members: ["alice"], agents: null, pinnedAgent: null, repos: [], state: "open", createdBy: "alice", createdAt: 1, lastMessageAt: 1, ...over });
const run = (id: string, over: Partial<Run> = {}): Run => ({ id, chatId: "team", agentId: "ag", dispatchedBy: "alice", dispatchMessageId: "m1", state: "working", branch: null, landing: null, openRequests: [], interruptRequested: false, machine: "Mac", model: null, effort: null, createdAt: 2, startedAt: 2, endedAt: null, ...over });
const message = (id: string, over: Partial<Message> = {}): Message => ({ id, chatId: "team", author: { type: "person", login: "alice" }, kind: "text", text: id, runId: null, turn: null, reactions: [], attachments: [], createdAt: 1, ...over });
const world = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({ workspaceId: "ws", chats: [chat("team")], activity: {}, presence: [], runs: { live: [], ended: [] }, ...over });
const types = (events: LayerEvent[]) => events.map((e) => e.type);

it("says nothing when nothing changed", () => {
  const s = world({ presence: [{ login: "bob", chatId: "team" }], runs: { live: [run("r1")], ended: [] } });
  expect(diffWorkspace(s, structuredClone(s))).toEqual([]);
});

it("turns a workspace's changes into what a world would animate", () => {
  const before = world({ presence: [{ login: "bob", chatId: null }, { login: "carol", chatId: "team" }], runs: { live: [run("r1")], ended: [] } });
  const after = world({
    chats: [chat("team", { title: "Renamed" }), chat("new")],
    activity: { team: "ask" },
    presence: [{ login: "bob", chatId: "team" }, { login: "dan", chatId: "new" }],
    runs: { live: [run("r1", { openRequests: ["q1"] }), run("r2", { chatId: "new", state: "queued" })], ended: [] },
  });
  const events = diffWorkspace(before, after);
  expect(types(events)).toEqual(["chat.updated", "chat.created", "chat.status", "person.moved", "person.arrived", "person.left", "run.asking", "run.started"]);
  expect(events.find((e) => e.type === "person.moved")).toEqual({ type: "person.moved", login: "bob", chatId: "team", previous: null });
  expect(events.find((e) => e.type === "chat.status")).toEqual({ type: "chat.status", chatId: "team", status: "ask", previous: "idle" });
});

it("reports how a run ended, once", () => {
  const working = world({ runs: { live: [run("r1", { openRequests: ["q1"] })], ended: [] } });
  const landed = world({ runs: { live: [], ended: [run("r1", { state: "landed", endedAt: 9 })] } });
  const events = diffWorkspace(working, landed);
  expect(types(events)).toEqual(["run.answered", "run.ended"]);
  expect(events[1]).toMatchObject({ run: { id: "r1", state: "landed" } });
  expect(diffWorkspace(landed, structuredClone(landed))).toEqual([]);
});

it("treats a newly visible chat's history as history, and a vanished chat's run as ended with it", () => {
  const shared = world({ chats: [chat("team"), chat("shared")], runs: { live: [], ended: [run("old", { chatId: "shared", state: "landed" })] } });
  expect(types(diffWorkspace(world(), shared))).toEqual(["chat.created"]);
  const gone = world({ chats: [], runs: { live: [], ended: [] } });
  expect(types(diffWorkspace(world({ runs: { live: [run("r1")], ended: [] } }), gone))).toEqual(["chat.removed"]);
});

it("streams a chat: posts, growing replies, run events and changes", () => {
  const before: ChatSnapshot = { chatId: "team", messages: [message("m1")], runs: [run("r1")], events: { r1: [{ type: "turn.started", runId: "r1", turnId: "t1" }] }, changes: [] };
  const after: ChatSnapshot = {
    ...before,
    messages: [message("m1"), message("m2", { kind: "report", author: { type: "agent", agentId: "ag" }, runId: "r1", turn: 1, text: "On i" })],
    events: { r1: [...before.events["r1"]!, { type: "item.started", runId: "r1", itemId: "i1", kind: "bash", summary: "ls" }] },
    changes: [{ id: "c1", chatId: "team", repo: "o/r", branch: "b", base: "main", state: "open", title: "t", prUrl: null, prNumber: null, draft: null, add: 1, del: 0, files: 1, checks: null, adopted: false, createdBy: "alice", updatedAt: 1, resolvedAt: null }],
  };
  expect(types(diffChat(before, after))).toEqual(["message.posted", "run.event", "change.opened"]);
  const grown = { ...after, messages: [after.messages[0]!, { ...after.messages[1]!, text: "On it" }] };
  expect(diffChat(after, grown)).toEqual([{ type: "message.updated", message: grown.messages[1], previous: after.messages[1] }]);
});

it("reads a chat the way the plain apps do", () => {
  const snapshot: ChatSnapshot = {
    chatId: "team",
    messages: [message("m1", { kind: "dispatch", runId: "r1", createdAt: 1 }), message("m2", { kind: "report", author: { type: "agent", agentId: "ag" }, runId: "r1", turn: 1, text: "Looking", createdAt: 3 })],
    runs: [run("r1", { createdAt: 1 })],
    events: { r1: [
      { type: "turn.started", runId: "r1", turnId: "t1", at: 2 },
      { type: "item.started", runId: "r1", itemId: "i1", kind: "bash", summary: "ls", at: 4 },
      { type: "request.opened", runId: "r1", requestId: "q1", kind: "approval", prompt: "Run rm?", options: ["Allow", "Deny"], at: 5 },
    ] },
    changes: [],
  };
  const rows = chatTimeline(snapshot);
  expect(rows.map((r) => r.kind)).toEqual(["message", "message", "activity", "status"]);
  expect(rows[1]).toMatchObject({ kind: "message", message: { id: "m2" } });
  expect(rows[2]).toMatchObject({ kind: "activity", run: { id: "r1" }, turn: { activity: [{ itemId: "i1" }] } });
  expect(openRequests(snapshot)).toMatchObject([{ requestId: "q1", prompt: "Run rm?", run: { id: "r1" } }]);
});

it("sends the token with every call and emits a snapshot before any events", () => {
  const subs = new Map<string, { args: Record<string, unknown>; push: (v: unknown) => void }>();
  const transport: Transport = {
    query: async (fn, args) => ({ fn, args }),
    mutation: async () => null,
    subscribe: (fn, args, onValue) => { subs.set(fn, { args, push: onValue }); return () => subs.delete(fn); },
    close: async () => {},
  };
  const beam = new Beam(transport, "blt_x");
  const events: LayerEvent[] = [];
  const stop = beam.watchWorkspace("ws", (e) => events.push(e));
  expect([...subs.values()].every((s) => s.args["token"] === "blt_x" && s.args["workspaceId"] === "ws")).toBe(true);
  subs.get("v1/chats:list")!.push([chat("team")]);
  subs.get("v1/chats:activity")!.push({});
  subs.get("v1/people:presence")!.push([]);
  expect(events).toEqual([]);
  subs.get("v1/runs:active")!.push({ live: [], ended: [] });
  expect(types(events)).toEqual(["workspace.snapshot"]);
  subs.get("v1/people:presence")!.push([{ login: "bob", chatId: "team" }]);
  expect(types(events)).toEqual(["workspace.snapshot", "person.arrived"]);
  stop();
  expect(subs.size).toBe(0);
});
