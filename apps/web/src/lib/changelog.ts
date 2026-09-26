import { useSyncExternalStore } from "react";
import source from "../../../../CHANGELOG.md?raw";

export type Release = { title: string; date: string | null; items: string[] };

/** `## 0.1.4 — 2026-09-23` or `## Unreleased`, each followed by `- ` lines. Anything else is prose and skipped. */
export function parseChangelog(text: string): Release[] {
  return text.split(/^## /m).slice(1).map((block) => {
    const [head = "", ...lines] = block.split("\n");
    const [title = "", date = null] = head.split(/\s+[—-]\s+/);
    return { title: title.trim(), date: date?.trim() || null, items: lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()) };
  }).filter((r) => r.items.length);
}

export const releases = parseChangelog(source);

/** Changes whenever the newest section does, so a new line under Unreleased counts as news too. */
const latest = releases[0] ? `${releases[0].title}:${releases[0].items.length}:${releases[0].items[0]}` : "";
const KEY = "beam.changelog.seen";
const listeners = new Set<() => void>();
const read = () => { try { return localStorage.getItem(KEY) === latest; } catch { return true; } };

export function markChangelogSeen() {
  try { localStorage.setItem(KEY, latest); } catch {}
  for (const l of listeners) l();
}

/** True when the newest changelog section has not been opened on this device. */
export function useChangelogUnseen() {
  return !useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, read);
}
