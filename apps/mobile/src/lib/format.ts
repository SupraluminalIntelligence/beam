/** Relative time for list rows: now, 4m, 3h, 2d. */
export function ago(t: number, now = Date.now()): string {
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
export const hhmm = (t: number) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
export const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
export const duration = (ms: number | null) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
export function dayLabel(t: number, now = new Date()): string {
  const d = new Date(t);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
