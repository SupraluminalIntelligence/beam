import { expect, it } from "vitest";
import { emptyRun, type ActivityLine, type RunView } from "@beam/reducer";
import { timeline } from "./timeline";

const run = { _id: "r", _creationTime: 1, agentId: "a", dispatchMessageId: "dispatch", state: "working", startedAt: 2, endedAt: null, landing: null };
const message = (id: string, at: number, author: string, kind: string, text = id) => ({ _id: id, _creationTime: at, author, kind, text, runId: "r", turn: 1 });
const step = (itemId: string, at: number): ActivityLine => ({ itemId, kind: "bash", summary: itemId, detail: null, ok: null, ms: null, startedAt: at });
const view = (): RunView => ({ ...emptyRun("r"), turns: [{ turn: 1, turnId: "t1", startedAt: 2, endedAt: null, done: false, activity: [step("before", 4), step("after", 7), step("more", 8)] }] });

it("interleaves steers between activity groups and agent replies", () => {
  const rows = timeline([message("dispatch", 1, "alice", "dispatch"), message("reply1", 3, "agent:a", "report"), message("steer", 5, "alice", "steer"), message("reply2", 9, "agent:a", "report")], [run], { r: view() });
  expect(rows.map((r) => r.key)).toEqual(["dispatch", "reply1", "r:before", "steer", "r:after", "reply2", "status:r"]);
  const groups = rows.filter((r) => r.kind === "activity");
  expect(groups.map((r) => r.turn.activity.map((a) => a.itemId))).toEqual([["before"], ["after", "more"]]);
  expect(rows.filter((r) => r.kind === "status")).toHaveLength(1);
  expect(rows.find((r) => r.key === "reply1")?.live).toBe(false);
  expect(rows.find((r) => r.key === "reply2")?.live).toBe(true);
});

it("updates tools in place and orders reply starts independently of mutation latency", () => {
  const v = view(); v.messageStarts = { reply: 3 };
  const msgs = [message("reply", 10, "agent:a", "report"), message("steer", 5, "alice", "steer")];
  const before = timeline(msgs, [run], { r: v });
  v.turns[0]!.activity[0] = { ...step("before", 4), ok: true, ms: 3000 };
  const after = timeline(msgs, [run], { r: v });
  expect(after.map((r) => r.key)).toEqual(before.map((r) => r.key));
  expect(after[0]?.key).toBe("reply");
});

it("puts a landing after all work and keeps turns and runs in separate groups", () => {
  const v = view();
  v.turns.push({ turn: 2, turnId: "t2", startedAt: 11, endedAt: 12, done: true, activity: [step("next-turn", 11)] });
  const rows = timeline([], [{ ...run, state: "landed", endedAt: 12, landing: { repos: [{ pushed: true }] } }], { r: v });
  expect(rows.map((r) => r.kind)).toEqual(["activity", "activity", "landing"]);
  expect(rows.filter((r) => r.live)).toHaveLength(0);
});
