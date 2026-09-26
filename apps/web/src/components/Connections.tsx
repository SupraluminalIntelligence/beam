import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { useLocalRunner } from "../lib/localRunner";
import { AgentAvatar } from "./Avatar";
import { Select } from "./Select";
import { toast } from "./Toast";

const names: Record<string, string> = { codex: "Codex", claude: "Claude Code", omp: "omp" };
const choiceValue = (runnerId: string, connectionId: string) => JSON.stringify([runnerId, connectionId]);
function parseChoice(value: string) { const [runnerId, connectionId] = JSON.parse(value) as [Id<"runners">, string]; return { runnerId, connectionId }; }

type Preview = { override?: { runnerId?: Id<"runners">; connectionId?: string } | null; options: { runnerId: Id<"runners">; connectionId: string; name: string; machineName: string; email: string | null; online: boolean }[]; selected: { runnerId: Id<"runners">; connectionId: string; name: string; machineName: string; owner: string; email: string | null; remote: boolean; source: string } | null; error: string | null } | undefined;

/**
 * The composer's agent chip: which model and effort your run will use, and which account this chat runs on.
 * Quiet by default; it turns amber only when the run could not start as things stand.
 */
export function ComposerAgent({ chatId, agent, model, effort, preview, onOpenDefaults }: {
  chatId: Id<"chats">; agent: { harness: string; handle: string }; model: string; effort: string; preview: Preview; onOpenDefaults: () => void;
}) {
  const save = useMutation(api.connections.setPreference);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // The account list renders in a portal; picking from it is not a click outside.
    const outside = (e: PointerEvent) => { const t = e.target as Element; if (!root.current?.contains(t) && !t.closest?.(".bsel-list")) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open]);
  const harness = agent.harness;
  const selected = preview?.selected;
  const override = preview?.override;
  const value = override?.runnerId ? choiceValue(override.runnerId, override.connectionId ?? "default") : selected?.source === "chat" ? choiceValue(selected.runnerId, selected.connectionId) : "";
  // In the desktop app the usual cause is this Mac's own runner having stopped; say so and offer the fix.
  const b = bridge();
  const localRunner = useLocalRunner();
  const runnerDown = !!b && !localRunner && !!preview?.error;
  const error = runnerDown ? "Beam’s runner on this Mac isn’t running, so there is no machine to run on." : preview?.error ?? null;
  const [restarting, setRestarting] = useState(false);
  const restart = async () => { setRestarting(true); try { await b!.restartRunner(); toast("Restarting the runner…"); } catch (e) { toast((e as Error).message); } finally { setTimeout(() => setRestarting(false), 4000); } };
  return <div className="composer-agent" ref={root}>
    <button ref={trigger} className={`tool-chip${error ? " warn" : ""}`} aria-expanded={open} title={error ?? `${names[harness] ?? harness} · ${model} · ${effort}${selected ? ` · ${selected.name} on ${selected.machineName}` : ""}`} onClick={() => setOpen(!open)}>
      <AgentAvatar harness={harness} /><span>{model} · {effort}</span>{error && <span>· can’t run</span>}
      <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open && <div className="agent-options" aria-label={`@${agent.handle} in this chat`}>
      <div className="agent-sec"><h4>Account for this chat</h4>
        <Select label="Account for this chat" disabled={!preview || busy} value={value} placeholder="Selected account unavailable" onChange={async v => {
          setBusy(true); try { await save({ chatId, harness, ...(v ? parseChoice(v) : {}) }); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
        }} options={[{ value: "", label: "Use my default" }, ...(preview?.options ?? []).map(o => ({ value: choiceValue(o.runnerId, o.connectionId), label: `${o.name}${o.email ? ` · ${o.email}` : ""}`, hint: `${o.machineName}${o.online ? "" : " · offline"}` }))]} />
        {runnerDown && <button className="btn ghost agent-restart" disabled={restarting} onClick={() => void restart()}>{restarting ? "Restarting…" : "Restart runner"}</button>}
        <span className={error ? "connection-error" : "connection-resolved"} role="status">{selected ? `Runs as ${selected.owner}’s ${selected.name}${selected.email ? ` (${selected.email})` : ""} on ${selected.machineName}${selected.remote ? "" : " · this machine"}` : error ?? "Checking account…"}</span>
      </div>
      <div className="agent-sec"><h4>Your model</h4>
        <div className="agent-model"><span>{names[harness] ?? harness} · {model} · {effort}</span><button className="btn ghost" onClick={() => { setOpen(false); onOpenDefaults(); }}>Change</button></div>
        <p>Yours in every workspace, set in Models &amp; accounts.</p>
      </div>
    </div>}
  </div>;
}

type Profiles = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof bridge>>["connections"]>>>;

/** This desktop's saved provider profiles, through the preload bridge. Null in a browser. */
export function useLocalProfiles() {
  const b = bridge();
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  useEffect(() => { if (b?.connections) void b.connections({ action: "list" }).then(setProfiles).catch(e => toast(e.message)); }, []);
  return [profiles, setProfiles] as const;
}

/** Inside this machine's card: which login each CLI uses here, and adding another. Credentials stay on this machine. */
export function LocalAccounts({ profiles, setProfiles, onChange }: { profiles: Profiles; setProfiles: (p: Profiles) => void; onChange: () => Promise<void> }) {
  const b = bridge();
  const [adding, setAdding] = useState(false);
  const [profileHarness, setProfileHarness] = useState<"codex" | "claude">("codex");
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false);
  const done = async (updated: Profiles) => { setProfiles(updated); setProfileName(""); setAdding(false); await onChange(); };
  return <section className="connection-settings local-accounts">
    {(["codex", "claude"] as const).map(harness => <div className="row" key={harness}><span>{names[harness]} login</span><Select label={`Local ${names[harness]} default`} disabled={busy} value={profiles.defaults[harness] ?? "default"} onChange={async v => {
      setBusy(true); try { setProfiles(await b!.connections!({ action: "default", harness, id: v })); await onChange(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }} options={[{ value: "default", label: "Existing CLI login" }, ...profiles.profiles.filter(p => p.harness === harness).map(p => ({ value: p.id, label: p.name }))]} /></div>)}
    {!adding ? <div className="row connection-note"><span><button className="btn ghost" onClick={() => setAdding(true)}>+ Add account</button></span></div> : <>
      <div className="row connection-add"><Select label="New account provider" value={profileHarness} onChange={setProfileHarness} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} /><input type="text" aria-label="Account name" placeholder="Work account" autoFocus maxLength={80} value={profileName} onChange={e => setProfileName(e.target.value)} /><button className="btn" disabled={busy || !profileName.trim()} onClick={async () => {
        setBusy(true); try { const updated = await b!.connections!({ action: "create", harness: profileHarness, name: profileName }); await done(updated); const added = updated.profiles.at(-1); if (added) await b?.signInConnection?.(added.harness, added.id); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
      }}>Sign in</button><button className="btn ghost" disabled={busy || !profileName.trim()} onClick={async () => {
        const configDir = await b?.pickFolder(); if (!configDir) return;
        setBusy(true); try { await done(await b!.connections!({ action: "add", harness: profileHarness, name: profileName, configDir })); toast("Profile connected. Sign in with the provider CLI using this profile directory if needed."); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
      }}>Use profile folder…</button><button className="btn ghost" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
      <div className="row connection-note"><span className="hint">Sign in opens Terminal with the provider’s login. Credentials stay on this machine.</span></div>
    </>}
  </section>;
}
