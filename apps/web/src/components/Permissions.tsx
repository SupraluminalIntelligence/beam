import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";

export const PERMISSION_MODES = [
  { v: "ask", label: "Supervised", hint: "Ask before risky commands and file changes." },
  { v: "plan", label: "Plan", hint: "Read-only until the plan is approved." },
  { v: "auto", label: "Full access", hint: "Allow commands and edits without prompts." },
] as const;
export const permissionLabel = (mode: string) => PERMISSION_MODES.find(m => m.v === mode)?.label ?? (mode === "allowlist" ? "Allow list" : mode);

export function PermissionIcon({ mode }: { mode: string }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mode === "plan" ? <><path d="M14 4H5v16h14v-9M9 15l1-4L18 3l3 3-8 8-4 1Z" /></> : mode === "mixed" ? <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="var(--surface)" /><circle cx="15" cy="17" r="2" fill="var(--surface)" /></> : <><rect x="5" y="10" width="14" height="11" rx="2" /><path d={mode === "auto" ? "M8 10V6a4 4 0 0 1 7.5-2" : "M8 10V6a4 4 0 0 1 8 0v4"} /></>}
  </svg>;
}

export function ComposerPermissions({ agents }: { agents: Doc<"agents">[] }) {
  const update = useMutation(api.workspaces.updateAgent);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modes = new Set(agents.map(a => a.permissionMode));
  const mode = modes.size === 1 ? agents[0]!.permissionMode : "mixed";
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); };
  }, [open]);
  if (!agents.length) return null;
  async function choose(agent: Doc<"agents">, value: string) {
    setBusy(true);
    try {
      await update({ agentId: agent._id, patch: { permissionMode: value } });
      toast(`@${agent.handle} → ${permissionLabel(value)} · next run`);
      setOpen(false); trigger.current?.focus();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update permissions"); }
    finally { setBusy(false); }
  }
  return <div className="composer-permissions" ref={root}>
    <button ref={trigger} className="permission-trigger" aria-expanded={open} aria-label={`Agent permissions: ${mode === "mixed" ? "Mixed" : permissionLabel(mode)}`} title="Agent permissions" onClick={() => setOpen(!open)}><PermissionIcon mode={mode} /><span>{mode === "mixed" ? "Permissions" : permissionLabel(mode)}</span><span aria-hidden="true">⌄</span></button>
    {open && <div className="permission-options" aria-label="Agent permissions">
      <p>Shared agent settings · applies to next runs</p>
      {agents.map(agent => <section key={agent._id} aria-label={`Permissions for @${agent.handle}`}>
        <h4>@{agent.handle}</h4>
        {agent.permissionMode === "allowlist" && <p>Current: Allow list (configured in agent settings)</p>}
        {PERMISSION_MODES.map(m => <button key={m.v} disabled={busy} aria-pressed={agent.permissionMode === m.v} onClick={() => void choose(agent, m.v)}><PermissionIcon mode={m.v} /><span><b>{m.label}</b><small>{m.hint}</small></span>{agent.permissionMode === m.v && <span aria-hidden="true">✓</span>}</button>)}
      </section>)}
    </div>}
  </div>;
}
