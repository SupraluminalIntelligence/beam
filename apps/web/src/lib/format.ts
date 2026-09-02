import type { ReactNode } from "react";
import { createElement } from "react";

export const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function dayLabel(t: number): string {
  const d = new Date(t), now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export const MENTION = /(^|\s)@([a-z0-9-]+)\b/gi;
export function firstMention(text: string, handles: Set<string>): string | null {
  for (const m of text.matchAll(MENTION)) { const h = m[2]!.toLowerCase(); if (handles.has(h)) return h; }
  return null;
}

/** Render `code` and @mentions. No HTML, no markdown beyond that in M0. */
export function renderText(text: string, agentHandles: Set<string>, people: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) { out.push(createElement("code", { key: i }, part.slice(1, -1))); return; }
    let last = 0;
    for (const m of part.matchAll(MENTION)) {
      const idx = m.index! + m[1]!.length;
      if (idx > last) out.push(part.slice(last, idx));
      const h = m[2]!.toLowerCase();
      const cls = agentHandles.has(h) ? `mention ${h === "codex" ? "codex" : h === "omp" ? "omp" : "claude"}` : people.has(h) ? "mention noah" : "";
      out.push(cls ? createElement("span", { key: `${i}-${idx}`, className: cls }, `@${m[2]}`) : `@${m[2]}`);
      last = idx + m[2]!.length + 1;
    }
    if (last < part.length) out.push(part.slice(last));
  });
  return out;
}

export const initials = (name: string) => name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
export const hueClass = (login: string) => { let h = 0; for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ["me", "noah"][h % 2]!; };
