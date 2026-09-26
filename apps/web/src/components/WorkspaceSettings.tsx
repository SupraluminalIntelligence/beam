import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { HARNESS_INFO } from "../lib/harness-info";
import { AgentAvatar, PersonAvatar } from "./Avatar";
import { Seg } from "./Modal";
import { toast } from "./Toast";

export type WorkspaceDetail = { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] };
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const PERMISSIONS = [["ask", "Supervised"], ["plan", "Plan"], ["auto", "Full access"], ["allowlist", "Allow list"]] as const;
const CONTEXT = [["last-landing", "last landing"], ["since-landing-plus-summary", "since last landing + summary"], ["whole-chat", "whole chat"]] as const;
const label = <T extends string>(options: readonly (readonly [T, string])[], v: string) => options.find(([k]) => k === v)?.[1] ?? v;

/**
 * Everything this workspace shares with its members: its name, repos, people and agents.
 * Personal choices (model, effort, account) live in Models & accounts and follow you across workspaces.
 */
export function WorkspaceSettings({ detail, focusAgent, onInvite, onAddRepo, onOpenDefaults }: {
  detail: WorkspaceDetail; focusAgent: string | null; onInvite: () => void; onAddRepo: () => void; onOpenDefaults: () => void;
}) {
  const people = useQuery(api.users.byLogins, { logins: detail.members });
  const [open, setOpen] = useState<string | null>(focusAgent);
  useEffect(() => { setOpen(focusAgent); }, [focusAgent]);
  return <div className="ws-settings">
    <WorkspaceName detail={detail} />
    <div className="sb-sec ws-sec">Repos<button className="btn ghost" onClick={onAddRepo}>Connect a repo</button></div>
    {detail.repos.length ? detail.repos.map((r) => <div key={r} className="row ws-item"><span className="k">{r}</span></div>)
      : <div className="row connection-note"><span className="hint">No repo yet. Agents need one to work in.</span></div>}
    <div className="sb-sec ws-sec">Members<button className="btn ghost" onClick={onInvite}>Invite</button></div>
    {detail.members.map((l) => <div key={l} className="row ws-item"><span className="ws-person"><PersonAvatar login={l} name={people?.[l]?.name ?? l} image={people?.[l]?.image ?? null} className="xs" />{people?.[l]?.name ?? l}{people?.[l] && people[l]!.name !== l && <span className="k">{l}</span>}</span></div>)}
    <div className="sb-sec ws-sec">Agents<button className="btn ghost" aria-expanded={open === "new"} onClick={() => setOpen(open === "new" ? null : "new")}>Add agent</button></div>
    {open === "new" && <AddAgent detail={detail} onAdded={(id) => setOpen(id)} />}
    {detail.agents.map((a) => <div key={a._id} className={`ws-agent${open === a._id ? " open" : ""}`}>
      <button className="ws-agent-row" aria-expanded={open === a._id} onClick={() => setOpen(open === a._id ? null : a._id)}>
        <AgentAvatar harness={a.harness} /><span className="nm">{HARNESS_NAME[a.harness] ?? a.harness}</span><span className="k">@{a.handle}</span>
        <span className="sp" /><span className="k">{label(PERMISSIONS, a.permissionMode)} · {label(CONTEXT, a.contextPolicy)}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
      </button>
      {open === a._id && <AgentForm key={a._id} a={a} detail={detail} onClose={() => setOpen(null)} onOpenDefaults={onOpenDefaults} />}
    </div>)}
  </div>;
}

function WorkspaceName({ detail }: { detail: WorkspaceDetail }) {
  const rename = useMutation(api.workspaces.rename);
  return <div className="row"><span>Name</span><input type="text" aria-label="Workspace name" key={detail.name} defaultValue={detail.name} maxLength={48}
    onBlur={(e) => { const next = e.target.value.trim(); if (!next) e.target.value = detail.name; else if (next !== detail.name) void rename({ workspaceId: detail.id, name: next }).then(() => toast("Workspace renamed")).catch((err) => { e.target.value = detail.name; toast(err.message); }); }}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.value = detail.name; e.currentTarget.blur(); } }} /></div>;
}

function AddAgent({ detail, onAdded }: { detail: WorkspaceDetail; onAdded: (id: Id<"agents">) => void }) {
  const add = useMutation(api.workspaces.addAgent);
  return <div className="list ws-add">
    {(["claude", "codex", "omp"] as const).map((h) => {
      const n = detail.agents.filter((x) => x.harness === h).length;
      return <button key={h} onClick={async () => { try { onAdded(await add({ workspaceId: detail.id, harness: h })); } catch (e) { toast((e as Error).message); } }}><AgentAvatar harness={h} /><span className="nm">{HARNESS_NAME[h]}<small>{HARNESS_INFO[h]!.vendor}</small></span><span className="d">{n ? `${n} in workspace` : ""}</span></button>;
    })}
  </div>;
}

/** What everyone in the workspace gets when they @ this agent. */
function AgentForm({ a, detail, onClose, onOpenDefaults }: { a: Doc<"agents">; detail: WorkspaceDetail; onClose: () => void; onOpenDefaults: () => void }) {
  const update = useMutation(api.workspaces.updateAgent);
  const remove = useMutation(api.workspaces.removeAgent);
  const preferences = useQuery(api.users.preferences);
  const [draft, setDraft] = useState<Partial<Doc<"agents">>>({});
  const info = HARNESS_INFO[a.harness]!;
  const v = { ...a, ...draft };
  const mine = preferences?.find((p) => p.harness === a.harness);
  const save = async () => {
    try {
      const patch = { ...(draft.handle !== undefined ? { handle: v.handle || a.handle } : {}), ...(draft.permissionMode !== undefined ? { permissionMode: v.permissionMode } : {}), ...(draft.alwaysAllow !== undefined ? { alwaysAllow: v.alwaysAllow } : {}), ...(draft.contextPolicy !== undefined ? { contextPolicy: v.contextPolicy } : {}) };
      await update({ agentId: a._id, patch }); setDraft({}); onClose(); toast(`Saved for everyone in ${detail.name}`);
    } catch (e) { toast((e as Error).message); }
  };
  return <div className="ws-agent-form">
    <div className="row"><span>Name in chat</span><span className="val">@<input type="text" value={v.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value.replace(/[^a-z0-9-]/g, "") })} style={{ width: 140, display: "inline-block", marginLeft: 2 }} /></span></div>
    <div className="row"><span>Permissions</span><Seg value={v.permissionMode} options={PERMISSIONS} onChange={(x) => setDraft({ ...draft, permissionMode: x })} /></div>
    <div className="row"><span>Always allow</span><input type="text" value={v.alwaysAllow.join(", ")} onChange={(e) => setDraft({ ...draft, alwaysAllow: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></div>
    <div className="row"><span>Context on dispatch</span><Seg value={v.contextPolicy} options={CONTEXT} onChange={(x) => setDraft({ ...draft, contextPolicy: x })} /></div>
    <div className="row"><span>Instructions</span><span className="hint">{info.files} from repo root · needs {info.min} locally</span></div>
    <div className="row set-note"><span className="hint">Your runs use {mine ? `${mine.model} · ${mine.effort}` : "your defaults"}, set in Models &amp; accounts.</span><button className="btn ghost" onClick={onOpenDefaults}>Models &amp; accounts</button></div>
    <div className="row ws-agent-actions"><button className="btn ghost" onClick={async () => { if (detail.agents.length <= 1) { toast("Keep at least one agent"); return; } try { await remove({ agentId: a._id }); toast("Agent removed from workspace"); } catch (e) { toast((e as Error).message); } }}>Remove</button><button className="btn" disabled={!Object.keys(draft).length} onClick={() => void save()}>Save</button></div>
  </div>;
}
