import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";

/** Open dialogs, oldest first: only the topmost answers Escape (Settings opened over a share dialog closes first). */
const stack: object[] = [];

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A dialog over the app. Opening it moves keyboard focus inside and Tab stays there, so typing never
 * reaches the composer behind it; closing hands focus back to where it was. Escape closes it unless a
 * control inside already handled the key (a Select's list, a rename field).
 */
export function Modal({ open, onClose, className = "", children }: { open: boolean; onClose: () => void; className?: string; children: ReactNode }) {
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
    const token = {};
    stack.push(token);
    const before = opener.current;
    // A field with autoFocus inside already has it; otherwise the dialog itself takes focus.
    if (!box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && stack.at(-1) === token) { e.preventDefault(); close.current(); } };
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("keydown", k);
      stack.splice(stack.indexOf(token), 1);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]!, last = items.at(-1)!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`modal ${className}`} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={trap}>{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return <span className="seg">{options.map(([v, label]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>)}</span>;
}
