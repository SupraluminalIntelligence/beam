import { z } from "zod";

/**
 * Subscription usage limits for one connected account: how much of each plan window is spent and
 * when it resets. Probes read the whole set; runs stream single-window updates that land on the same
 * rows by id. Percentages only; Beam never sees a credential or a bill.
 */
export const UsageWindow = z.object({
  id: z.string(),
  kind: z.enum(["session", "weekly", "monthly", "other"]),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageLimits = z.object({
  checkedAt: z.number(),
  windows: z.array(UsageWindow),
  /** unsupported: the account has no plan windows (API key, Bedrock). failed: this read did not work. */
  unavailable: z.enum(["unsupported", "failed"]).optional(),
});
export type UsageLimits = z.infer<typeof UsageLimits>;

const ORDER: Record<UsageWindow["kind"], number> = { session: 0, weekly: 1, monthly: 2, other: 3 };
const HOUR = 60, WEEK = 7 * 24 * 60, MONTH = 30 * 24 * 60;
const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
const sorted = (windows: Iterable<UsageWindow>) => [...windows].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.id.localeCompare(b.id));
const isoMs = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const secMs = (s: number | null | undefined) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s * 1000 : null);

export const usageLimits = (checkedAt: number, windows: Iterable<UsageWindow>): UsageLimits => ({ checkedAt, windows: sorted(windows) });
export const usageUnavailable = (checkedAt: number, unavailable: "unsupported" | "failed"): UsageLimits => ({ checkedAt, windows: [], unavailable });

// ---- Claude Code ----
const CLAUDE: Record<string, Pick<UsageWindow, "kind" | "label">> = {
  five_hour: { kind: "session", label: "5-hour session" },
  seven_day: { kind: "weekly", label: "Weekly" },
  seven_day_opus: { kind: "weekly", label: "Weekly · Opus" },
  seven_day_sonnet: { kind: "weekly", label: "Weekly · Sonnet" },
};
type ClaudeWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

/** The Agent SDK's experimental usage read. Utilization there is already 0–100. */
export function claudeUsage(response: { rate_limits_available: boolean; rate_limits: Record<string, unknown> | null } | null, checkedAt: number): UsageLimits {
  if (!response) return usageUnavailable(checkedAt, "failed");
  if (!response.rate_limits_available || !response.rate_limits) return usageUnavailable(checkedAt, "unsupported");
  const windows: UsageWindow[] = [];
  for (const [id, meta] of Object.entries(CLAUDE)) {
    const w = response.rate_limits[id] as ClaudeWindow;
    if (w && typeof w.utilization === "number") windows.push({ id, ...meta, usedPercent: clamp(w.utilization), resetsAt: isoMs(w.resets_at) });
  }
  return usageLimits(checkedAt, windows);
}

/** A streamed `rate_limit_event` names one window with a 0–1 fraction. Unknown buckets are dropped rather than guessed. */
export function claudeRateLimitUpdate(info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): UsageWindow[] {
  const meta = info.rateLimitType ? CLAUDE[info.rateLimitType] : undefined;
  if (!meta || typeof info.utilization !== "number") return [];
  return [{ id: info.rateLimitType!, ...meta, usedPercent: clamp(info.utilization * 100), resetsAt: secMs(info.resetsAt) }];
}

// ---- Codex ----
type CodexWindow = { usedPercent: number; resetsAt?: number | null; windowDurationMins?: number | null } | null | undefined;
export type CodexRateLimits = { limitId?: string | null; planType?: string | null; primary?: CodexWindow; secondary?: CodexWindow };

/**
 * `account/rateLimits/read` and `account/rateLimits/updated` share this snapshot. Primary and secondary
 * are positions, not durations: paid plans have a 5-hour and a weekly window, Free and Go one monthly.
 * Model-specific snapshots are ignored so they never overwrite the main allowance.
 */
export function codexRateLimitWindows(snapshot: CodexRateLimits | null | undefined): UsageWindow[] {
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== "codex")) return [];
  const monthly = snapshot.planType === "free" || snapshot.planType === "go";
  const out: UsageWindow[] = [];
  for (const [id, w, fallback] of [["primary", snapshot.primary, monthly ? MONTH : 5 * HOUR], ["secondary", snapshot.secondary, WEEK]] as const) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = w.windowDurationMins ?? fallback;
    const kind = mins >= MONTH ? "monthly" : mins >= WEEK ? "weekly" : "session";
    const label = kind === "session" ? `${Math.round(mins / HOUR)}-hour session` : kind === "weekly" ? "Weekly" : "Monthly";
    out.push({ id, kind, label, usedPercent: clamp(w.usedPercent), resetsAt: secMs(w.resetsAt) });
  }
  return out;
}

// ---- merging ----

/**
 * Fold a streamed update into what the account last published. Windows upsert by id; a window the
 * update omits keeps its values. An unsupported account stays unsupported. Returns `previous`
 * itself when nothing changed, so callers can skip the write.
 */
export function applyUsageUpdate(previous: UsageLimits | undefined, windows: UsageWindow[], now: number): UsageLimits | undefined {
  if (!windows.length || previous?.unavailable === "unsupported") return previous;
  const merged = new Map((previous?.windows ?? []).map((w) => [w.id, w] as const));
  let changed = !previous || !!previous.unavailable;
  for (const w of windows) {
    const old = merged.get(w.id);
    const next = { ...w, usedPercent: clamp(w.usedPercent), resetsAt: w.resetsAt ?? old?.resetsAt ?? null };
    if (!old || old.usedPercent !== next.usedPercent || old.resetsAt !== next.resetsAt || old.label !== next.label || old.kind !== next.kind) { merged.set(w.id, next); changed = true; }
  }
  return changed ? usageLimits(now, merged.values()) : previous;
}

/** After a probe: a failed read keeps the last good windows; anything else replaces them. */
export function usageAfterProbe(published: UsageLimits | undefined, probed: UsageLimits | undefined): UsageLimits | undefined {
  if (probed?.unavailable === "failed" && published && !published.unavailable) return published;
  return probed ?? published;
}

/** A window whose reset time has passed no longer describes the account. */
export function currentWindows(limits: UsageLimits | undefined, now: number): UsageWindow[] {
  return (limits?.windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now);
}

/** The window closest to its cap, for one-line summaries. */
export function tightestWindow(limits: UsageLimits | undefined, now: number): UsageWindow | null {
  return currentWindows(limits, now).reduce<UsageWindow | null>((top, w) => (!top || w.usedPercent > top.usedPercent ? w : top), null);
}

// ---- a runner's stored harness statuses (loose JSON in Convex) ----
type StatusRow = { harness?: unknown; connectionId?: unknown; usage?: unknown };
const key = (s: StatusRow) => `${String(s.harness)}:${typeof s.connectionId === "string" ? s.connectionId : "default"}`;
const parsedUsage = (value: unknown) => UsageLimits.safeParse(value).data;

/** A fresh probe replaces the statuses but keeps each connection's last good usage when its read failed. */
export function mergeProbedUsage(previous: unknown, next: unknown): unknown {
  if (!Array.isArray(next)) return next;
  const old = new Map((Array.isArray(previous) ? previous as StatusRow[] : []).map((s) => [key(s), parsedUsage(s?.usage)] as const));
  return next.map((s: StatusRow) => {
    const usage = usageAfterProbe(old.get(key(s)), parsedUsage(s?.usage));
    return usage ? { ...s, usage } : s;
  });
}

/** A run's streamed windows for one connection. Null when nothing changed, so the caller skips the write. */
export function applyConnectionUsage(statuses: unknown, harness: string, connectionId: string, windows: UsageWindow[], now: number): unknown[] | null {
  if (!Array.isArray(statuses)) return null;
  const at = statuses.findIndex((s: StatusRow) => key(s) === `${harness}:${connectionId}`);
  if (at < 0) return null;
  const row = statuses[at] as StatusRow;
  const previous = parsedUsage(row.usage);
  const next = applyUsageUpdate(previous, windows, now);
  if (!next || next === previous) return null;
  return statuses.map((s, i) => (i === at ? { ...row, usage: next } : s));
}
