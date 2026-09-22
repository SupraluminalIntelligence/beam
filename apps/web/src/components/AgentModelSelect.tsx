import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { HarnessStatus } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { HARNESS_INFO } from "../lib/harness-info";
import { toast } from "./Toast";

export function AgentModelSelect({ agent }: { agent: Doc<"agents"> }) {
  const preferences = useQuery(api.users.preferences);
  const mine = useQuery(api.runners.mine) ?? [];
  const shared = useQuery(api.runners.online, { workspaceId: agent.workspaceId }) ?? [];
  const requestProbe = useMutation(api.runners.requestProbe);
  const requestedProbe = useRef<string | null>(null);
  const save = useMutation(api.users.setAgentPreference);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const pref = preferences?.find(p => p.harness === agent.harness);
  const current = pref?.model ?? agent.model;
  const effort = pref?.effort ?? agent.effort;
  const runners = [...mine, ...shared.filter(r => r.allowSharedRuns && !mine.some(m => m.id === r.id))];
  const runner = pref?.runnerId ? runners.find(r => r.id === pref.runnerId) : mine.filter(r => (Array.isArray(r.harnesses) ? r.harnesses : []).some((h: { harness: string; auth: string }) => h.harness === agent.harness && h.auth === "authenticated")).sort((a, b) => Number(b.online) - Number(a.online) || Number(b.launchedByApp) - Number(a.launchedByApp))[0];
  const catalog = (Array.isArray(runner?.harnesses) ? runner.harnesses : []).map((h: unknown) => HarnessStatus.safeParse(h).data).find(h => h?.harness === agent.harness)?.models ?? [];
  useEffect(() => {
    if (agent.harness !== "codex" || catalog.length || !runner?.online || requestedProbe.current === String(runner.id)) return;
    requestedProbe.current = String(runner.id);
    void requestProbe({ runnerId: runner.id as Id<"runners"> }).catch(() => { requestedProbe.current = null; });
  }, [agent.harness, catalog.length, runner?.id, runner?.online, requestProbe]);
  const options = agent.harness === "codex" ? catalog : (HARNESS_INFO[agent.harness]?.models ?? []).map(model => ({ model, name: model, efforts: ["low", "medium", "high", "max"] }));
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
  const selected = options.find(m => normalize(m.model) === normalize(current) || normalize(m.name) === normalize(current));
  async function choose(model: string) {
    const option = options.find(m => m.model === model);
    if (!option) return;
    setBusy(true);
    try {
      const nextEffort = effort === "max" || option.efforts.includes(effort) ? effort : option.efforts.includes("medium") ? "medium" : option.efforts[0] ?? "max";
      await save({ harness: agent.harness, model, effort: nextEffort, ...(pref?.runnerId ? { runnerId: pref.runnerId } : {}) });
      toast(`${option.name} · your next run`);
      setOpen(false); trigger.current?.focus();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update model"); }
    finally { setBusy(false); }
  }
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const supported = agent.harness === "codex" ? selected?.efforts ?? [] : ["low", "medium", "high", "max"];
  const efforts = order.filter(e => supported.includes(e) || (e === "max" && supported.length > 0));
  const next = efforts[(efforts.indexOf(effort) + 1) % efforts.length];
  async function cycle() {
    if (busy || !next) return;
    setBusy(true);
    try {
      await save({ harness: agent.harness, model: selected?.model ?? current, effort: next, ...(pref?.runnerId ? { runnerId: pref.runnerId } : {}) });
      toast(`${next} effort · your next run`);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update effort"); }
    finally { setBusy(false); }
  }
  const level = efforts.length > 1 ? Math.max(1, Math.round(1 + 3 * efforts.indexOf(effort) / (efforts.length - 1))) : 1;
  return <>
    <div ref={root} className="agent-model model-picker">
      <button ref={trigger} className="ctl model-trigger" title="Model" aria-label={`Model for @${agent.handle}: ${selected?.name ?? current}`} aria-expanded={open} disabled={busy || preferences === undefined} onClick={() => setOpen(!open)}><span>{selected?.name ?? current}</span><i aria-hidden="true">▾</i></button>
      {open && <div className="model-menu" aria-label={`Models for @${agent.handle}`} onKeyDown={e => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
      }}>
        <div className="ddh">Model</div>
        {!selected && <div className="model-current">Current: {current}</div>}
        {options.map(m => <button key={m.model} disabled={busy} aria-pressed={selected?.model === m.model} onClick={() => void choose(m.model)}><span>{m.name}</span>{selected?.model === m.model && <span aria-hidden="true">✓</span>}</button>)}
        {!options.length && <p>{runner?.online ? "Loading available models…" : "Models will load when your runner reconnects."}</p>}
      </div>}
    </div>
    <button className="ctl eff" data-lv={level} disabled={busy || preferences === undefined || !next} aria-label={`Reasoning effort for @${agent.handle}: ${effort}${next ? `; change to ${next}` : ""}`} title={next ? `Next: ${next}` : runner?.online ? "Loading effort levels…" : "Waiting for runner to reconnect"} onClick={() => void cycle()}><span className="bars" aria-hidden="true"><i /><i /><i /><i /></span><span>{effort === "medium" ? "med" : effort}</span></button>
  </>;
}
