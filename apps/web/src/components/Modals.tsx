import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceRow } from "../App";
import { bridge } from "../bridge";
import { ui, useUi } from "../lib/ui";
import { AgentAvatar } from "./Avatar";
import { ApproveRunner, Harnesses } from "./Harnesses";
import { Modal, Seg } from "./Modal";
import type { Me } from "./Shell";
import { toast } from "./Toast";

type Detail = { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] };
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const HARNESS_INFO: Record<string, { vendor: string; models: string[]; min: string; files: string }> = {
  claude: { vendor: "Anthropic", models: ["Fable 5.1", "Fable 5.0", "Opus 5.0", "Sonnet 5.0"], min: "Claude Code ≥ 2.4", files: "CLAUDE.md, AGENTS.md" },
  codex: { vendor: "OpenAI", models: ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"], min: "Codex CLI ≥ 0.9", files: "AGENTS.md" },
  omp: { vendor: "via omp · pick a provider", models: ["GPT-5.6 Sol", "Kimi K3", "Gemini 3.5 Pro", "Claude Opus 5 (API key)"], min: "omp ≥ 1.0", files: "AGENTS.md, .omp/" },
};

export function SettingsModal({ open, onClose, me, pairCode }: { open: boolean; onClose: () => void; me: Me; pairCode?: string | null }) {
  const u = useUi();
  const { signOut } = useAuthActions();
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">Settings<span className="k hint">⌘,</span></div>
      <div className="row"><span>Account</span><span className="val">{me.name} <span className="hint">· {me.githubLogin}{me.isAnonymous ? " · guest" : ""}</span></span></div>
      <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Connected harnesses</div>
      <Harnesses />
      <ApproveRunner initial={pairCode ?? null} />
      <div className="row"><span>This machine</span><span className="hint">{bridge() ? "runner launched by the app on startup · your own logins, nothing stored" : "browser · a runner needs the desktop app or `beam-runner start` on a machine"}</span></div>
      <div className="row"><span>Adding people</span><Seg value={u.prefs.addToChat} options={[["auto", "add to the chat right away"], ["ask", "ask me first"]] as const} onChange={(v) => ui.setPref("addToChat", v)} /></div>
      <div className="row"><span>Shortcuts</span><span className="hint">⌘T chat · ⌘⇧T private · ⌘W close · ⌘K jump</span></div>
      <div className="m-f"><span>Per-agent settings live on each agent in the sidebar.</span><span><button className="btn ghost" onClick={() => void signOut()}>Log out</button> <button className="btn" onClick={onClose}>Done</button></span></div>
    </Modal>
  );
}

export function AgentSettingsModal({ open, agentId, detail, onClose }: { open: boolean; agentId: Id<"agents"> | null; detail: Detail; onClose: () => void }) {
  const update = useMutation(api.workspaces.updateAgent);
  const add = useMutation(api.workspaces.addAgent);
  const remove = useMutation(api.workspaces.removeAgent);
  const isNew = (agentId as unknown as string) === "new";
  const [cur, setCur] = useState<Id<"agents"> | null>(null);
  useEffect(() => { if (open && !isNew) setCur(agentId); }, [open, agentId, isNew]);
  const a = detail.agents.find((x) => x._id === (cur ?? agentId)) ?? null;
  const [draft, setDraft] = useState<Partial<Doc<"agents">>>({});
  const [modelOpen, setModelOpen] = useState(false);
  useEffect(() => { setDraft({}); setModelOpen(false); }, [a?._id, open]);
  if (!open) return null;

  if (isNew && !cur) {
    return (
      <Modal open onClose={onClose}>
        <div className="m-h">Add an agent<span className="k hint">a harness plus its settings</span></div>
        <div className="list">
          {(["claude", "codex", "omp"] as const).map((h) => {
            const n = detail.agents.filter((x) => x.harness === h).length;
            return <button key={h} onClick={async () => { const id = await add({ workspaceId: detail.id, harness: h }); setCur(id); }}><AgentAvatar harness={h} /><span className="nm">{HARNESS_NAME[h]}<small>{HARNESS_INFO[h]!.vendor}</small></span><span className="d">{n ? `${n} in workspace` : ""}</span></button>;
          })}
        </div>
        <div className="m-f"><span>A second Claude Code with a different model is a second agent with its own @name.</span></div>
      </Modal>
    );
  }
  if (!a) return null;
  const info = HARNESS_INFO[a.harness]!;
  const v = { ...a, ...draft };
  return (
    <Modal open onClose={onClose}>
      <div className="m-h">
        <span className="tabs2">{detail.agents.map((x) => <button key={x._id} className={x._id === a._id ? "on" : ""} onClick={() => setCur(x._id)}><AgentAvatar harness={x.harness} />{HARNESS_NAME[x.harness]}{x.handle !== x.harness ? ` @${x.handle}` : ""}</button>)}</span>
        <span className="k hint">workspace agent · needs {info.min} locally</span>
      </div>
      <div className="row"><span>Name in chat</span><span className="val">@<input type="text" value={v.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value.replace(/[^a-z0-9-]/g, "") })} style={{ width: 140, display: "inline-block", marginLeft: 2 }} /></span></div>
      <div className="row"><span>Model</span><span className={`sel${modelOpen ? " open" : ""}`} tabIndex={0} onClick={() => setModelOpen(!modelOpen)}><span>{v.model}</span><i>▾</i><span className="dd"><span className="ddh">{info.vendor}</span>{info.models.map((m) => <button key={m} className={m === v.model ? "on" : ""} onClick={(e) => { e.stopPropagation(); setDraft({ ...draft, model: m }); setModelOpen(false); }}>{m}</button>)}</span></span></div>
      <div className="row"><span>Reasoning effort</span><Seg value={v.effort} options={[["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"]] as const} onChange={(x) => setDraft({ ...draft, effort: x })} /></div>
      <div className="row"><span>Permissions</span><Seg value={v.permissionMode} options={[["ask", "ask in chat"], ["allowlist", "auto-allow list"], ["auto", "full auto"]] as const} onChange={(x) => setDraft({ ...draft, permissionMode: x })} /></div>
      <div className="row"><span>Always allow</span><input type="text" value={v.alwaysAllow.join(", ")} onChange={(e) => setDraft({ ...draft, alwaysAllow: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></div>
      <div className="row"><span>Context on dispatch</span><Seg value={v.contextPolicy} options={[["last-landing", "last landing"], ["since-landing-plus-summary", "since last landing + summary"], ["whole-chat", "whole chat"]] as const} onChange={(x) => setDraft({ ...draft, contextPolicy: x })} /></div>
      <div className="row"><span>Instructions</span><span className="hint">{info.files} from repo root</span></div>
      <div className="m-f"><span>Changes apply to the next run, on whichever runner it lands</span><span><button className="btn ghost" onClick={async () => { if (detail.agents.length <= 1) { toast("Keep at least one agent"); return; } await remove({ agentId: a._id }); onClose(); toast("Agent removed from workspace"); }}>Remove</button> <button className="btn" onClick={async () => { await update({ agentId: a._id, patch: { handle: v.handle || a.handle, model: v.model, effort: v.effort, permissionMode: v.permissionMode, alwaysAllow: v.alwaysAllow, contextPolicy: v.contextPolicy } }); onClose(); toast("Saved · applies to the next run"); }}>Save</button></span></div>
    </Modal>
  );
}

export function InviteModal({ open, onClose, wsId, wsName, chatId }: { open: boolean; onClose: () => void; wsId: Id<"workspaces">; wsName: string; chatId: Id<"chats"> | null }) {
  const invite = useMutation(api.workspaces.invite);
  const u = useUi();
  const [login, setLogin] = useState("");
  useEffect(() => { if (open) setLogin(""); }, [open]);
  const go = async () => {
    const v = login.trim();
    if (!v) { toast("Need a GitHub login"); return; }
    const addHere = chatId && (u.prefs.addToChat === "auto" || window.confirm(`Also add ${v} to this chat?`));
    const l = await invite({ workspaceId: wsId, githubLogin: v, chatId: addHere ? chatId : null });
    onClose(); toast(addHere ? `Invited ${l} · added to this chat too` : `Invited ${l} · they appear when they sign in`);
  };
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">Invite to {wsName}</div>
      <div className="row"><span>GitHub login</span><input type="text" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="octocat" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void go(); }} /></div>
      <div className="row"><span>Access</span><span className="hint">they connect their own harnesses · their machine becomes a runner while Beam is open</span></div>
      <div className="m-f"><span>Guests can be invited by their guest-xxxx login.</span><span><button className="btn ghost" onClick={onClose}>Cancel</button> <button className="btn" onClick={() => void go()}>Invite</button></span></div>
    </Modal>
  );
}

export function NewWorkspaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState(""); const [repo, setRepo] = useState("");
  useEffect(() => { if (open) { setName(""); setRepo(""); } }, [open]);
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">New workspace<span className="k hint">a team space · repos attach to chats</span></div>
      <div className="row"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" autoFocus /></div>
      <div className="row"><span>First repo</span><input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name · optional" /></div>
      <div className="m-f"><span>You can add more repos any time. People join by invite.</span><span><button className="btn ghost" onClick={onClose}>Cancel</button> <button className="btn" onClick={async () => { if (!name.trim()) { toast("Give it a name"); return; } const id = await create({ name: name.trim(), repo: repo.trim() || null }); ui.setWorkspace(id); onClose(); toast(`Workspace ${name.trim()} created`); }}>Create</button></span></div>
    </Modal>
  );
}

export function AddRepoModal({ open, onClose, wsId, wsName, chatId }: { open: boolean; onClose: () => void; wsId: Id<"workspaces">; wsName: string; chatId: Id<"chats"> | null }) {
  const addRepo = useMutation(api.workspaces.addRepo);
  const setRepo = useMutation(api.chats.setRepo);
  const [repo, setRepoV] = useState("");
  useEffect(() => { if (open) setRepoV(""); }, [open]);
  const go = async () => {
    const r = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) { toast("owner/name, please"); return; }
    await addRepo({ workspaceId: wsId, repo: r });
    if (chatId) await setRepo({ chatId, repo: r }).catch(() => {});
    onClose(); toast(`${r} connected`);
  };
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">Connect a repo to {wsName}</div>
      <div className="row"><span>Repo</span><input type="text" value={repo} onChange={(e) => setRepoV(e.target.value)} placeholder="owner/name or GitHub URL" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void go(); }} /></div>
      <div className="m-f"><span>Cloned once per runner, then worktrees per chat.</span><span><button className="btn ghost" onClick={onClose}>Cancel</button> <button className="btn" onClick={() => void go()}>Connect</button></span></div>
    </Modal>
  );
}

export function Palette({ open, onClose, workspaces }: { open: boolean; onClose: () => void; workspaces: WorkspaceRow[] }) {
  const u = useUi();
  const wsId = (u.ws ?? workspaces[0]?.id) as Id<"workspaces"> | undefined;
  const chats = useQuery(api.chats.list, wsId ? { workspaceId: wsId } : "skip");
  const [q, setQ] = useState("");
  useEffect(() => { if (open) setQ(""); }, [open]);
  const rows = (chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} className="pal">
      <input placeholder="Jump to a chat…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter" && rows[0] && wsId) { ui.openChat(wsId, rows[0]._id); onClose(); } }} />
      <div className="list">{rows.map((c) => <button key={c._id} onClick={() => { if (wsId) ui.openChat(wsId, c._id); onClose(); }}><span className="sq idle" /><span className="nm">{c.title}<small>{c.private ? "private" : `${c.members.length} member${c.members.length === 1 ? "" : "s"}`}{c.repo ? ` · ${c.repo}` : ""}</small></span><span className="d">{c.activeBranch ?? ""}</span></button>)}{rows.length === 0 && <div className="empty" style={{ padding: "16px 14px" }}>Nothing matches.</div>}</div>
    </Modal>
  );
}
