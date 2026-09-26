import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type SelectOption<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };

/**
 * Beam's dropdown: a mono trigger that opens a listbox on the sheet (hard offset shadow, no OS menu).
 * The list is fixed to the viewport so scrolling panes and dialogs cannot clip it, and flips above the
 * trigger when there is no room below. Escape closes the list only, not the dialog around it.
 */
export function Select<T extends string>({ value, options, onChange, label, disabled, className = "", placeholder }: {
  value: T; options: readonly SelectOption<T>[]; onChange: (v: T) => void; label: string; disabled?: boolean | undefined; className?: string; placeholder?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const current = options.find((o) => o.value === value);
  const enabled = (i: number) => !!options[i] && !options[i]!.disabled;

  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const show = () => {
    if (disabled || !options.length) return;
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };
  const pick = (i: number) => { if (!enabled(i)) return; if (options[i]!.value !== value) onChange(options[i]!.value); close(); };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom, above = r.top;
    const up = below < 220 && above > below;
    setPos({ left: r.left, top: up ? r.top - 4 : r.bottom + 4, width: Math.max(r.width, 180), up });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!list.current?.contains(t) && !trigger.current?.contains(t)) close(false); };
    const moved = (e: Event) => { if (!list.current?.contains(e.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved); window.addEventListener("scroll", moved, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", moved); window.removeEventListener("scroll", moved, true); };
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);

  const step = (from: number, dir: 1 | -1) => { for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i; return from; };
  const onListKey = (e: ReactKeyboardEvent) => {
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === "Tab") { close(false); return; }
    e.preventDefault();
    if (k === "ArrowDown") setActive((a) => step(a, 1));
    else if (k === "ArrowUp") setActive((a) => step(a, -1));
    else if (k === "Home") setActive(step(-1, 1));
    else if (k === "End") setActive(step(options.length, -1));
    else if (k === "Enter" || k === " ") pick(active);
    else if (k.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + k.toLowerCase(), at: now };
      const hit = options.findIndex((o, i) => enabled(i) && o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return <>
    <button ref={trigger} type="button" className={`bsel ${className}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => (open ? close() : show())}
      onKeyDown={(e) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); } }}>
      <span className={`bsel-v${current ? "" : " missing"}`}>{current?.label ?? placeholder ?? value}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open && pos && createPortal(
      <div ref={list} id={id} className="bsel-list" role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey}
        style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}>
        {options.map((o, i) => <div key={o.value} id={`${id}-${i}`} data-i={i} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
          className={i === active ? "active" : ""} onPointerEnter={() => enabled(i) && setActive(i)} onClick={() => pick(i)}>
          <span className="ck" aria-hidden="true">{o.value === value ? "✓" : ""}</span><span className="bsel-l">{o.label}</span>{o.hint && <span className="bsel-h">{o.hint}</span>}
        </div>)}
      </div>, document.body)}
  </>;
}
