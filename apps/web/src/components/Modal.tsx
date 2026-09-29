import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * Open dialogs, oldest first, each with where focus was before it opened. Only the topmost answers Escape
 * (Settings opened over a share dialog closes first).
 */
type Entry = { opener: HTMLElement | null };
const stack: Entry[] = [];

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const focusables = (box: HTMLElement) => Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);

/**
 * A dialog over the app. Opening it moves keyboard focus inside and Tab stays there, so typing never
 * reaches the composer behind it; closing hands focus back to where it was. Escape closes it unless a
 * control inside already handled the key (a Select's list, a rename field).
 */
export function Modal({ open, onClose, label, className = "", children }: { open: boolean; onClose: () => void; label: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Where focus was before opening, read while rendering: a child's autoFocus takes focus in the commit, before any effect runs.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  useEffect(() => {
    if (!open) return;
    const entry: Entry = { opener: opener.current };
    stack.push(entry);
    // A field with autoFocus inside already has it; otherwise the dialog itself takes focus.
    if (!box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => {
      if (stack.at(-1) !== entry || e.defaultPrevented) return;
      if (e.key === "Escape") { e.preventDefault(); close.current(); }
      // A control that removed itself (Cancel on an inline form) leaves focus on the body, where the trap below
      // never sees Tab; bring focus back inside first.
      else if (e.key === "Tab" && box.current && !box.current.contains(document.activeElement)) { e.preventDefault(); (focusables(box.current)[0] ?? box.current).focus({ preventScroll: true }); }
    };
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("keydown", k);
      stack.splice(stack.indexOf(entry), 1);
      // After the rest of this commit: a dialog replacing this one (Settings to Invite) mounts in the same pass.
      // It opened from inside this one, so it inherits where to return focus; otherwise focus goes back now.
      queueMicrotask(() => {
        // Still on screen: this was StrictMode replaying the effect, not a close.
        if (box.current?.isConnected) return;
        const next = stack.at(-1);
        if (next && !next.opener?.isConnected) next.opener = entry.opener;
        else if (entry.opener?.isConnected) entry.opener.focus({ preventScroll: true });
      });
    };
  }, [open]);
  if (!open) return null;
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = focusables(box.current);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]!, last = items.at(-1)!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return <span className="seg">{options.map(([v, label]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>)}</span>;
}
