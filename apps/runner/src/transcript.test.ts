import { expect, it } from "vitest";
import { Transcript } from "./transcript.ts";

it("freezes earlier text and continues below a tool or steer boundary", () => {
  const t = new Transcript();
  expect(t.write("turn1", "Looking", false)).toEqual([{ key: "segment1", text: "Looking" }]);
  expect(t.write("turn1", " now.", false)).toEqual([{ key: "segment1", text: "Looking now." }]);
  t.split();
  expect(t.write("turn1", "\n\nFound it.", false)).toEqual([{ key: "segment2", text: "\n\nFound it." }]);
  expect(t.write("turn1", "Looking now.\n\nFound it.", true)).toEqual([]);
  t.split();
  expect(t.write("turn1", "Looking now.\n\nFound it.\n\nDone.", true)).toEqual([{ key: "segment3", text: "\n\nDone." }]);
});

it("reconciles trimmed final replies across segment boundaries without duplication", () => {
  const t = new Transcript();
  t.write("turn", "  Before  ", false); t.split(); t.write("turn", "After  ", false);
  const updates = t.write("turn", "Before  After", true);
  expect(updates).toEqual([{ key: "segment1", text: "Before  " }, { key: "segment2", text: "After" }]);
});

it("reconciles rewritten final text and keeps independent provider messages separate", () => {
  const t = new Transcript();
  t.write("a", "Old text.", false); t.split(); t.write("a", " More.", false);
  const parts = new Map([["segment1", "Old text."], ["segment2", " More."]]);
  for (const p of t.write("a", "Corrected reply.", true)) parts.set(p.key, p.text);
  expect([...parts.values()].join("")).toBe("Corrected reply.");
  expect(t.write("b", "Next turn.", true)).toEqual([{ key: "segment3", text: "Next turn." }]);
});
