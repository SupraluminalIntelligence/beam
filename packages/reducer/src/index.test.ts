import { describe, expect, it } from "vitest";
import { fold } from "./index";

describe("reducer", () => {
  it("accumulates deltas and closes on turn.completed", () => {
    const v = fold("r1", [
      { type: "content.delta", runId: "r1" as never, messageId: "m1" as never, delta: "On " },
      { type: "content.delta", runId: "r1" as never, messageId: "m1" as never, delta: "it." },
      { type: "item.started", runId: "r1" as never, itemId: "t1", kind: "read", summary: "Read 6 files" },
      { type: "item.completed", runId: "r1" as never, itemId: "t1", summary: "Read 6 files", detail: null, ok: true, ms: 300 },
      { type: "turn.completed", runId: "r1" as never, turnId: "turn1" },
    ]);
    expect(v.text["m1"]).toBe("On it.");
    expect(v.activity[0]?.ok).toBe(true);
    expect(v.status).toBe("done");
  });
});
