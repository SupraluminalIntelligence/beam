import { useMutation, useQuery } from "convex/react";
import { HarnessStatus } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { connectionStatuses } from "../../../../packages/contracts/src/connections";
import { HARNESS_INFO } from "../lib/harness-info";
import { useLocalRunner } from "../lib/localRunner";
import { AgentAvatar } from "./Avatar";
import { Select } from "./Select";
import { toast } from "./Toast";

const HARNESSES = [["claude", "Claude Code"], ["codex", "Codex"], ["omp", "omp"]] as const;
const EFFORTS = ["low", "medium", "high", "max"];
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
type Runner = { id: unknown; name: string; online: boolean; harnesses: unknown; ownerLogin: string };

/**
 * Personal, not per workspace: which account, model and effort your runs use for each harness.
 * Stored on your user by harness, so it follows you into every workspace and every @agent of that harness.
 */
export function AgentDefaults({ workspaceId, onOpenMachines }: { workspaceId: Id<"workspaces">; onOpenMachines: () => void }) {
  const mine = useQuery(api.runners.mine);
  const shared = useQuery(api.runners.online, { workspaceId }) ?? [];
  const runners: Runner[] = [...(mine ?? []), ...shared.filter((r) => r.allowSharedRuns && !(mine ?? []).some((m) => m.id === r.id))];
  return <>
    {HARNESSES.map(([harness, name]) => <HarnessDefaults key={harness} harness={harness} name={name} runners={runners} onOpenMachines={onOpenMachines} />)}
    <div className="row connection-note"><span className="hint">Applies to runs you start, in every workspace. “At a computer” is the desktop app; “From phone and apps” is your phone, the <span className="mono">beam</span> CLI and Beam Worlds, which have no machine of their own. A chat can still pick its own account.</span></div>
  </>;
}

function HarnessDefaults({ harness, name, runners, onOpenMachines }: { harness: string; name: string; runners: Runner[]; onOpenMachines: () => void }) {
  const localRunnerId = useLocalRunner();
  const accountPreferences = useQuery(api.connections.preferences);
  const preferences = useQuery(api.users.preferences);
  const saveAccount = useMutation(api.connections.setPreference);
  const savePreference = useMutation(api.users.setAgentPreference);
  const info = HARNESS_INFO[harness]!;
  const preference = preferences?.find((p) => p.harness === harness);
  const account = accountPreferences?.find((p) => p.harness === harness);
  const accountValue = account?.runnerId ? JSON.stringify([account.runnerId, account.connectionId ?? "default"]) : "";
  const choice = accountValue ? JSON.parse(accountValue) as [string, string] : null;
  const runner = runners.find((r) => r.id === (choice?.[0] ?? localRunnerId));
  const status = HarnessStatus.safeParse(connectionStatuses(runner?.harnesses).find((h) => h.harness === harness && (choice ? h.connectionId === choice[1] : h.isDefault))).data;
  const catalog = status?.models ?? [];
  const models = harness === "codex" ? catalog : info.models.map((m) => ({ model: m, name: m, efforts: EFFORTS }));
  const model = preference?.model ?? models[0]?.model ?? info.models[0]!;
  const effort = preference?.effort ?? "high";
  const selected = models.find((m) => normalize(m.model) === normalize(model) || normalize(m.name) === normalize(model));
  const efforts = harness === "codex" ? [...new Set([...(selected?.efforts ?? []), "max"])] : EFFORTS;
  const accounts = runners.flatMap((r) => connectionStatuses(r.harnesses).filter((h) => h.harness === harness).map((h) => ({
    value: JSON.stringify([r.id, h.connectionId]), label: `${h.connectionName}${h.email ? ` · ${h.email}` : ""}`, hint: `${r.name}${r.online ? "" : " · offline"}`,
  })));
  const ready = !!preferences && !!accountPreferences;

  const saveModel = async (next: { model: string; effort: string }) => {
    try {
      await savePreference({ harness, ...next, ...(preference?.runnerId ? { runnerId: preference.runnerId, ...(preference.connectionId ? { connectionId: preference.connectionId } : {}) } : {}) });
      toast(`${name} · ${next.model} · ${next.effort} · your next run`);
    } catch (e) { toast((e as Error).message); }
  };

  return <section className="agent-defaults">
    <div className="hrow head"><AgentAvatar harness={harness} /><span className="nm">{name}</span><span className="sp" /><span className="hseen">needs {info.min}</span></div>
    {harness !== "omp" && <div className="row"><span>At a computer</span><Select label={`${name} account at a computer`} value={accountValue} disabled={!ready} placeholder="Selected account unavailable"
      onChange={(v) => void saveAccount({ harness, ...(v ? { runnerId: (JSON.parse(v) as [Id<"runners">, string])[0], connectionId: (JSON.parse(v) as [string, string])[1] } : {}) }).then(() => toast(`${name} account saved`)).catch((e) => toast(e.message))}
      options={[{ value: "", label: "That computer’s own default" }, ...accounts]} /></div>}
    {!accountValue && <AwayAccount harness={harness} name={name} runners={runners} />}
    <div className="row"><span>Model</span><Select label={`${name} model`} value={selected?.model ?? model} disabled={!ready}
      onChange={(m) => { const option = models.find((x) => x.model === m); void saveModel({ model: m, effort: option?.efforts.includes(effort) ? effort : option?.efforts[0] ?? "high" }); }}
      options={[...(!selected ? [{ value: model, label: model, hint: harness === "codex" ? "unavailable until refreshed" : "unavailable", disabled: true }] : []), ...models.map((m) => ({ value: m.model, label: m.name }))]} /></div>
    {harness === "codex" && !catalog.length && <div className="row set-note"><span className="hint">Codex models load from a machine’s last check.</span><button className="btn ghost" onClick={onOpenMachines}>Open Machines</button></div>}
    <div className="row"><span>Reasoning effort</span><Select label={`${name} reasoning effort`} value={effort} disabled={!ready}
      onChange={(e) => void saveModel({ model: selected?.model ?? model, effort: e })}
      options={[...(!efforts.includes(effort) ? [{ value: effort, label: effort, hint: "unavailable", disabled: true }] : []), ...efforts.map((e) => ({ value: e, label: e }))]} /></div>
  </section>;
}

/** Your own and shared accounts for one harness, as Select options. */
function accountOptions(harness: string, runners: Runner[]) {
  return runners.flatMap((r) => connectionStatuses(r.harnesses).filter((h) => h.harness === harness).map((h) => ({
    value: JSON.stringify([r.id, h.connectionId]), label: `${h.connectionName}${h.email ? ` · ${h.email}` : ""}`, hint: `${r.name}${r.online ? "" : " · offline"}`,
    signedIn: h.auth === "authenticated",
  })));
}

/**
 * Where an agent runs when you start it from somewhere with no machine of its own: the phone, the CLI, a Beam
 * World. Unset, those can't start it. With exactly one signed-in account to choose, it offers that one.
 */
export function AwayAccount({ harness, name, runners, label = "From phone and apps" }: { harness: string; name: string; runners: Runner[]; label?: string }) {
  const away = useQuery(api.connections.away);
  const save = useMutation(api.connections.setPreference);
  const options = accountOptions(harness, runners);
  const current = away?.find((p) => p.harness === harness);
  const value = current ? JSON.stringify([current.runnerId, current.connectionId]) : "";
  const only = !current && options.filter((o) => o.signedIn).length === 1 ? options.find((o) => o.signedIn)! : null;
  const set = (v: string) => void save({ harness, away: true, ...(v ? { runnerId: (JSON.parse(v) as [Id<"runners">, string])[0], connectionId: (JSON.parse(v) as [string, string])[1] } : {}) })
    .then(() => toast(v ? `${name} from phone and apps: saved` : `${name} can no longer start from phone and apps`)).catch((e) => toast((e as Error).message));
  return <>
    <div className="row"><span>{label}</span><Select label={`${name} account from phone and apps`} value={value} disabled={away === undefined} placeholder="Selected account unavailable"
      onChange={set} options={[{ value: "", label: "Not set: can’t start from phone or apps" }, ...options]} /></div>
    {only && <div className="row set-note"><span className="hint">{only.label} on {only.hint} is your only signed-in {name} account.</span><button className="btn ghost" onClick={() => set(only.value)}>Use it</button></div>}
  </>;
}
