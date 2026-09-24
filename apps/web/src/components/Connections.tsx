import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { connectionStatuses } from "../../../../packages/contracts/src/connections";
import { bridge } from "../bridge";
import { useLocalRunner } from "../lib/localRunner";
import { toast } from "./Toast";
import { MachineNameSetting } from "./MachineNameSetting";

const names: Record<string, string> = { codex: "Codex", claude: "Claude Code", omp: "omp" };
const choiceValue = (runnerId: string, connectionId: string) => JSON.stringify([runnerId, connectionId]);
function parseChoice(value: string) { const [runnerId, connectionId] = JSON.parse(value) as [Id<"runners">, string]; return { runnerId, connectionId }; }

export function ConnectionPicker({ chatId, harness, preview }: {
  chatId: Id<"chats">; harness: string;
  preview: { override?: { runnerId?: Id<"runners">; connectionId?: string } | null; options: { runnerId: Id<"runners">; connectionId: string; name: string; machineName: string; email: string | null; online: boolean }[]; selected: { runnerId: Id<"runners">; connectionId: string; name: string; machineName: string; owner: string; email: string | null; remote: boolean; source: string } | null; error: string | null } | undefined;
}) {
  const save = useMutation(api.connections.setPreference);
  const [busy, setBusy] = useState(false);
  const selected = preview?.selected;
  const override = preview?.override;
  const value = override?.runnerId ? choiceValue(override.runnerId, override.connectionId ?? "default") : selected?.source === "chat" ? choiceValue(selected.runnerId, selected.connectionId) : "";
  return <div className="connection-picker">
    <label><span className="sr-only">Account for this chat</span><select aria-label="Account for this chat" disabled={!preview || busy} value={value} onChange={async e => {
      setBusy(true); try { await save({ chatId, harness, ...(e.target.value ? parseChoice(e.target.value) : {}) }); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }}>
      <option value="">Use my default</option>
      {value && !preview?.options.some(o => choiceValue(o.runnerId, o.connectionId) === value) && <option value={value}>Selected connection unavailable</option>}
      {preview?.options.map(o => <option key={choiceValue(o.runnerId, o.connectionId)} value={choiceValue(o.runnerId, o.connectionId)}>{o.name}{o.email ? ` · ${o.email}` : ""} · {o.machineName}{o.online ? "" : " · offline"}</option>)}
    </select></label>
    <span className={preview?.error ? "connection-error" : "connection-resolved"} role="status">{selected ? `${selected.owner}’s ${names[harness] ?? harness} · ${selected.name}${selected.email ? ` (${selected.email})` : ""} · ${selected.machineName}${selected.remote ? " · remote" : " · this machine"}` : preview?.error ?? "Checking account…"}</span>
  </div>;
}

export function ConnectionSettings() {
  const runners = useQuery(api.runners.mine) ?? [];
  const preferences = useQuery(api.connections.preferences);
  const save = useMutation(api.connections.setPreference);
  const probe = useMutation(api.runners.requestProbe);
  const localId = useLocalRunner();
  const b = bridge();
  const [profiles, setProfiles] = useState<Awaited<ReturnType<NonNullable<NonNullable<typeof b>["connections"]>>> | null>(null);
  const [profileHarness, setProfileHarness] = useState<"codex" | "claude">("codex");
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (b?.connections) void b.connections({ action: "list" }).then(setProfiles).catch(e => toast(e.message)); }, []);
  const refresh = async () => { if (localId) await probe({ runnerId: localId }); };
  return <section className="connection-settings">
    <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Accounts and machines</div>
    <div className="row connection-note"><span className="hint">By default, new runs use this machine’s account. A preferred account applies across your devices.</span></div>
    {(["codex", "claude"] as const).map(harness => {
      const p = preferences?.find(p => p.harness === harness);
      const options = runners.flatMap(r => connectionStatuses(r.harnesses).filter(s => s.harness === harness).map(s => ({ ...s, runner: r })));
      const value = p?.runnerId ? choiceValue(p.runnerId, p.connectionId ?? "default") : "";
      return <div className="row" key={harness}><span>{names[harness]} account</span><select aria-label={`Preferred ${names[harness]} account`} value={value} disabled={!preferences} onChange={e => void save({ harness, ...(e.target.value ? parseChoice(e.target.value) : {}) }).catch(e => toast(e.message))}>
        <option value="">This machine’s default</option>
        {value && !options.some(o => choiceValue(o.runner.id as string, o.connectionId) === value) && <option value={value}>Selected connection unavailable</option>}
        {options.map(o => <option key={choiceValue(o.runner.id as string, o.connectionId)} value={choiceValue(o.runner.id as string, o.connectionId)}>{o.connectionName}{o.email ? ` · ${o.email}` : ""} · {o.runner.name}{o.runner.online ? "" : " · offline"}</option>)}
      </select></div>;
    })}
    <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Machine names</div>
    <div className="row connection-note"><span className="hint">Choose a readable name, such as “Apek’s MacBook Pro” or “Office Mac”. Shown in run details and machine pickers throughout Beam.</span></div>
    {runners.map(r => <MachineNameSetting key={String(r.id)} runner={{ ...r, id: r.id as Id<"runners"> }} local={r.id === localId} />)}
    {profiles && <>
      {(["codex", "claude"] as const).map(harness => <div className="row" key={harness}><span>Local {names[harness]} default</span><select aria-label={`Local ${names[harness]} default`} disabled={busy} value={profiles.defaults[harness] ?? "default"} onChange={async e => {
        setBusy(true); try { setProfiles(await b!.connections!({ action: "default", harness, id: e.target.value })); await refresh(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
      }}><option value="default">Existing CLI account</option>{profiles.profiles.filter(p => p.harness === harness).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>)}
      {profiles.profiles.map(p => <div className="row" key={p.id}><span>{p.name} · {names[p.harness]}</span><button className="btn ghost" disabled={!b?.signInConnection} onClick={() => void b?.signInConnection?.(p.harness, p.id).catch(e => toast(e.message))}>Sign in</button></div>)}
      <div className="row connection-add"><span>Add local account</span><select aria-label="New account provider" value={profileHarness} onChange={e => setProfileHarness(e.target.value as "codex" | "claude")}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><input type="text" aria-label="Account name" placeholder="Work account" maxLength={80} value={profileName} onChange={e => setProfileName(e.target.value)} /><button className="btn" disabled={busy || !profileName.trim()} onClick={async () => {
        setBusy(true); try { const updated = await b!.connections!({ action: "create", harness: profileHarness, name: profileName }); setProfiles(updated); setProfileName(""); await refresh(); const added = updated.profiles.at(-1); if (added) await b?.signInConnection?.(added.harness, added.id); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
      }}>Add account</button><button className="btn ghost" disabled={busy || !profileName.trim()} onClick={async () => {
        const configDir = await b?.pickFolder(); if (!configDir) return;
        setBusy(true); try { setProfiles(await b!.connections!({ action: "add", harness: profileHarness, name: profileName, configDir })); setProfileName(""); await refresh(); toast("Profile connected. Sign in with the provider CLI using this profile directory if needed."); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
      }}>Choose profile folder</button></div>
      <div className="row connection-note"><span className="hint">Add an account to sign in in your terminal, or connect an existing profile folder. Credentials stay on this machine. Refresh Connected harnesses after signing in.</span></div>
    </>}
  </section>;
}
