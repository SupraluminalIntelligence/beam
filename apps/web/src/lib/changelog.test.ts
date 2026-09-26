import { describe, expect, it } from "vitest";
import { parseChangelog, releases } from "./changelog";

describe("parseChangelog", () => {
  it("reads sections with optional dates and skips prose", () => {
    expect(parseChangelog("# Changelog\n\nIntro.\n\n## Unreleased\n\n- One\n- Two\n\n## 0.1.4 — 2026-09-23\n\n- Three\n\n## 0.1.3\n\nNothing listed.\n")).toEqual([
      { title: "Unreleased", date: null, items: ["One", "Two"] },
      { title: "0.1.4", date: "2026-09-23", items: ["Three"] },
    ]);
  });
  it("parses the shipped changelog", () => {
    expect(releases.length).toBeGreaterThan(1);
    expect(releases.every((r) => r.items.length > 0)).toBe(true);
  });
});
