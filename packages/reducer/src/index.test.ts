import { describe, expect, it } from "vitest";
import { fold } from "./index";

const r = "r1" as never;
describe("reducer", () => {
  it("accumulates deltas and closes on turn.completed", () => {
    const v = fold("r1", [
      { type: "turn.started", runId: r, turnId: "turn1" },
      { type: "content.delta", runId: r, messageId: "m1" as never, delta: "On " },
      { type: "content.delta", runId: r, messageId: "m1" as never, delta: "it." },
      { type: "item.started", runId: r, itemId: "t1", kind: "read", summary: "Read 6 files" },
      { type: "item.completed", runId: r, itemId: "t1", summary: "Read 6 files", detail: null, ok: true, ms: 300 },
      { type: "turn.completed", runId: r, turnId: "turn1" },
    ]);
    expect(v.text["m1"]).toBe("On it.");
    expect(v.activity[0]?.ok).toBe(true);
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]?.done).toBe(true);
    expect(v.status).toBe("done");
  });
  it("keeps activity per turn and tracks open requests", () => {
    const v = fold("r1", [
      { type: "turn.started", runId: r, turnId: "a" },
      { type: "item.started", runId: r, itemId: "x", kind: "bash", summary: "npm test" },
      { type: "request.opened", runId: r, requestId: "q1", kind: "approval", prompt: "Bash: rm -rf dist", options: ["allow", "deny"] },
      { type: "turn.completed", runId: r, turnId: "a" },
      { type: "turn.started", runId: r, turnId: "b" },
      { type: "item.completed", runId: r, itemId: "x", summary: "npm test", detail: "ok", ok: true, ms: 10 },
      { type: "item.started", runId: r, itemId: "y", kind: "edit", summary: "Edit a.ts" },
      { type: "request.resolved", runId: r, requestId: "q1", by: "noah" as never, decision: "allow" },
    ]);
    expect(v.turns.map((t) => t.activity.map((a) => a.itemId))).toEqual([["x"], ["y"]]);
    expect(v.turns[0]?.activity[0]?.ok).toBe(true);
    expect(v.requests).toHaveLength(0);
    expect(v.resolved["q1"]?.by).toBe("noah");
    expect(v.status).toBe("working");
  });
});
