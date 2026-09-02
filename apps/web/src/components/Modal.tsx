import type { ReactNode } from "react";
import { useEffect } from "react";

export function Modal({ open, onClose, className = "", children }: { open: boolean; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${className}`}>{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return <span className="seg">{options.map(([v, label]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>)}</span>;
}
