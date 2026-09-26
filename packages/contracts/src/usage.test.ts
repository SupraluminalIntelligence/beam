import { describe, expect, it } from "vitest";
import { applyConnectionUsage, applyUsageUpdate, mergeProbedUsage, claudeRateLimitUpdate, claudeUsage, codexRateLimitWindows, currentWindows, tightestWindow, usageAfterProbe, usageLimits, usageUnavailable } from "./usage.ts";

describe("claudeUsage", () => {
  it("maps plan windows and sorts session before weekly", () => {
    const u = claudeUsage({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: "2026-10-01T00:00:00Z" }, five_hour: { utilization: 112, resets_at: null }, seven_day_opus: null } }, 1);
    expect(u.windows.map((w) => [w.id, w.usedPercent])).toEqual([["five_hour", 100], ["seven_day", 40]]);
    expect(u.windows[1]!.resetsAt).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });
  it("tells an API-key account from a failed read", () => {
    expect(claudeUsage({ rate_limits_available: false, rate_limits: null }, 1).unavailable).toBe("unsupported");
    expect(claudeUsage(null, 1).unavailable).toBe("failed");
  });
  it("turns a streamed fraction into a percentage and drops unknown buckets", () => {
    expect(claudeRateLimitUpdate({ rateLimitType: "five_hour", utilization: 0.625, resetsAt: 100 })).toEqual([{ id: "five_hour", kind: "session", label: "5-hour session", usedPercent: 62.5, resetsAt: 100_000 }]);
    expect(claudeRateLimitUpdate({ rateLimitType: "overage", utilization: 0.1 })).toEqual([]);
    expect(claudeRateLimitUpdate({ rateLimitType: "five_hour" })).toEqual([]);
  });
});

describe("codexRateLimitWindows", () => {
  it("reads durations when present", () => {
    const w = codexRateLimitWindows({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 50 }, secondary: { usedPercent: 30, windowDurationMins: 10080 } });
    expect(w.map((x) => [x.id, x.kind, x.label, x.resetsAt])).toEqual([["primary", "session", "5-hour session", 50_000], ["secondary", "weekly", "Weekly", null]]);
  });
  it("treats Free and Go primary as monthly and ignores model-specific snapshots", () => {
    expect(codexRateLimitWindows({ planType: "free", primary: { usedPercent: 5 } })[0]!.kind).toBe("monthly");
    expect(codexRateLimitWindows({ limitId: "spark", primary: { usedPercent: 5 } })).toEqual([]);
  });
});

describe("merging", () => {
  const base = usageLimits(1, [{ id: "five_hour", kind: "session", label: "5-hour session", usedPercent: 10, resetsAt: 500 }, { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: 900 }]);
  it("upserts one window and keeps the others and a known reset time", () => {
    const next = applyUsageUpdate(base, [{ id: "five_hour", kind: "session", label: "5-hour session", usedPercent: 55, resetsAt: null }], 2)!;
    expect(next.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([["five_hour", 55, 500], ["seven_day", 20, 900]]);
    expect(next.checkedAt).toBe(2);
  });
  it("returns the same object when nothing changed", () => {
    expect(applyUsageUpdate(base, [base.windows[0]!], 2)).toBe(base);
    expect(applyUsageUpdate(base, [], 2)).toBe(base);
  });
  it("never adds windows to an unsupported account but replaces a failed read", () => {
    const unsupported = usageUnavailable(1, "unsupported");
    expect(applyUsageUpdate(unsupported, base.windows, 2)).toBe(unsupported);
    expect(applyUsageUpdate(usageUnavailable(1, "failed"), base.windows, 2)!.windows).toHaveLength(2);
  });
  it("keeps the last good windows when a probe fails", () => {
    expect(usageAfterProbe(base, usageUnavailable(3, "failed"))).toBe(base);
    expect(usageAfterProbe(base, usageUnavailable(3, "unsupported"))!.unavailable).toBe("unsupported");
    expect(usageAfterProbe(base, undefined)).toBe(base);
  });
  it("hides windows that already reset and picks the tightest", () => {
    expect(currentWindows(base, 600).map((w) => w.id)).toEqual(["seven_day"]);
    expect(tightestWindow(base, 0)!.id).toBe("seven_day");
    expect(tightestWindow(base, 1000)).toBeNull();
  });
});

describe("stored statuses", () => {
  const good = usageLimits(1, [{ id: "primary", kind: "session", label: "5-hour session", usedPercent: 30, resetsAt: null }]);
  it("keeps the last good usage per connection when a re-probe fails", () => {
    const prev = [{ harness: "codex", connectionId: "work", usage: good }, { harness: "claude", usage: good }];
    const next = mergeProbedUsage(prev, [{ harness: "codex", connectionId: "work", usage: usageUnavailable(2, "failed") }, { harness: "claude", usage: usageUnavailable(2, "unsupported") }, { harness: "omp" }]) as { usage?: unknown }[];
    expect(next[0]!.usage).toEqual(good);
    expect(next[1]!.usage).toEqual(usageUnavailable(2, "unsupported"));
    expect(next[2]).toEqual({ harness: "omp" });
  });
  it("applies a run's windows to the matching connection only", () => {
    const rows = [{ harness: "codex", connectionId: "work", usage: good }, { harness: "codex", usage: good }];
    const next = applyConnectionUsage(rows, "codex", "default", [{ ...good.windows[0]!, usedPercent: 80 }], 5) as { usage: { windows: { usedPercent: number }[] } }[];
    expect(next.map((r) => r.usage.windows[0]!.usedPercent)).toEqual([30, 80]);
    expect(applyConnectionUsage(rows, "codex", "work", good.windows, 5)).toBeNull();
    expect(applyConnectionUsage(rows, "claude", "default", good.windows, 5)).toBeNull();
  });
});
