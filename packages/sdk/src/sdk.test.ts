import { expect, it, vi } from "vitest";
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
  const s = world({ presence: [{ login: "bob", chatId: "team", layer: null }], runs: { live: [run("r1")], ended: [] } });
  expect(diffWorkspace(s, structuredClone(s))).toEqual([]);
});

it("turns a workspace's changes into what a world would animate", () => {
  const before = world({ presence: [{ login: "bob", chatId: null, layer: null }, { login: "carol", chatId: "team", layer: null }], runs: { live: [run("r1")], ended: [] } });
  const after = world({
    chats: [chat("team", { title: "Renamed" }), chat("new")],
    activity: { team: "ask" },
    presence: [{ login: "bob", chatId: "team", layer: null }, { login: "dan", chatId: "new", layer: null }],
    runs: { live: [run("r1", { openRequests: ["q1"] }), run("r2", { chatId: "new", state: "queued" })], ended: [] },
  });
  const events = diffWorkspace(before, after);
  expect(types(events)).toEqual(["chat.updated", "chat.created", "chat.status", "person.moved", "person.arrived", "person.left", "run.asking", "run.started"]);
  expect(events.find((e) => e.type === "person.moved")).toEqual({ type: "person.moved", login: "bob", chatId: "team", previous: null, layer: null });
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
  subs.get("v1/people:presence")!.push([{ login: "bob", chatId: "team", layer: null }]);
  expect(types(events)).toEqual(["workspace.snapshot", "person.arrived"]);
  stop();
  expect(subs.size).toBe(0);
});

it("says when someone steps into another layer, and follows a layer's own state", () => {
  const state = (people: { login: string; data: unknown }[], workspace: unknown = null) => ({ layer: "office", people: people.map((p) => ({ ...p, updatedAt: 1 })), chats: [], workspace: workspace === null ? null : { data: workspace, updatedBy: "alice", updatedAt: 1 } });
  const before = world({ presence: [{ login: "bob", chatId: "team", layer: null }], layerState: state([{ login: "bob", data: { x: 1 } }, { login: "carol", data: { x: 9 } }]) });
  const after = world({ presence: [{ login: "bob", chatId: "team", layer: "office" }], layerState: state([{ login: "bob", data: { x: 2 } }, { login: "dan", data: { x: 0 } }], { theme: "hamsters" }) });
  expect(diffWorkspace(before, after)).toEqual([
    { type: "person.moved", login: "bob", chatId: "team", previous: "team", layer: "office" },
    { type: "layer.person", layer: "office", login: "bob", data: { x: 2 }, previous: { x: 1 } },
    { type: "layer.person", layer: "office", login: "dan", data: { x: 0 }, previous: null },
    { type: "layer.person", layer: "office", login: "carol", data: null, previous: { x: 9 } },
    { type: "layer.workspace", layer: "office", data: { theme: "hamsters" }, previous: null },
  ]);
});

function recording() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const transport: Transport = { query: async () => null, mutation: async (fn, args) => { calls.push({ fn, args }); return null; }, subscribe: () => () => {}, close: async () => {} };
  return { beam: new Beam(transport, "blt_x"), calls };
}

it("acts through the catalog with the token, leaving out what was not given", async () => {
  const { beam, calls } = recording();
  await beam.send("c1", "hi @claude");
  await beam.send("c1", "and this", { runId: "r1" });
  await beam.respond("r1", "q1", "allow");
  await beam.focus("ws", null, "office");
  await beam.setState("ws", "office", "chat", { desks: 4 }, "c1");
  expect(calls).toEqual([
    { fn: "v1/messages:send", args: { chatId: "c1", text: "hi @claude", token: "blt_x" } },
    { fn: "v1/messages:send", args: { chatId: "c1", text: "and this", runId: "r1", token: "blt_x" } },
    { fn: "v1/runs:respond", args: { runId: "r1", requestId: "q1", decision: "allow", token: "blt_x" } },
    { fn: "v1/people:focus", args: { workspaceId: "ws", chatId: null, layer: "office", token: "blt_x" } },
    { fn: "v1/layers:set", args: { workspaceId: "ws", layer: "office", scope: "chat", data: { desks: 4 }, chatId: "c1", token: "blt_x" } },
  ]);
});

it("sends every-frame state at a steady rate, always ending on the latest", async () => {
  vi.useFakeTimers();
  const { beam, calls } = recording();
  const place = beam.placer("ws", "office", { interval: 250 });
  for (let x = 0; x < 30; x++) { place({ x }); await vi.advanceTimersByTimeAsync(20); } // 600 ms of frames
  await vi.advanceTimersByTimeAsync(500);
  const xs = calls.map((c) => (c.args["data"] as { x: number }).x);
  expect(xs.length).toBeLessThanOrEqual(4);
  expect(xs.at(-1)).toBe(29);
  vi.useRealTimers();
});
