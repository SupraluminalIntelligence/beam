import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceRow } from "../App";
import { bridge } from "../bridge";
import { ui, useUi } from "../lib/ui";
import { AgentAvatar } from "./Avatar";
import { Machines } from "./Harnesses";
import { Modal, Seg } from "./Modal";
import { Select } from "./Select";
import type { Me } from "./Shell";
import { toast } from "./Toast";
import { PersonAvatar } from "./Avatar";
import { hueClass } from "../lib/format";
import { HOSTED_URL } from "../App";
import { NotificationSettings } from "./Notifications";
import { useLocalRunner } from "../lib/localRunner";
import { connectionStatuses } from "../../../../packages/contracts/src/connections";
import { ResourceSharingPolicy } from "./SharedResources";
import { HarnessStatus } from "@beam/contracts";

type Detail = { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] };
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
import { HARNESS_INFO } from "../lib/harness-info";

export type SettingsTab = "general" | "machines" | "notifications" | `agent:${string}`;
const SETTINGS_TABS = [
  ["general", "General", <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></>],
  ["machines", "Machines", <><rect x="3" y="4" width="18" height="12" rx="1" /><path d="M8 20h8M12 16v4" /></>],
  ["notifications", "Notifications", <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>],
] as const;
const agentLabel = (a: Doc<"agents">) => `${HARNESS_NAME[a.harness] ?? a.harness}${a.handle !== a.harness ? ` @${a.handle}` : ""}`;

export function SettingsModal({ open, onClose, me, detail, pairCode, tab: initialTab = "general" }: { open: boolean; onClose: () => void; me: Me; detail: Detail; pairCode?: string | null; tab?: SettingsTab | undefined }) {
  const u = useUi();
  const { signOut } = useAuthActions();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => { if (open) setTab(pairCode ? "machines" : initialTab); }, [open, initialTab, pairCode]);
  const agentId = tab.startsWith("agent:") ? tab.slice(6) : null;
  const agent = detail.agents.find((a) => a._id === agentId) ?? null;
  const title = agentId === "new" ? "Add an agent" : agent ? agentLabel(agent) : SETTINGS_TABS.find(([v]) => v === tab)?.[1] ?? "Agent";
  const sub = agentId === "new" ? "a harness plus its settings" : agent ? `${detail.name} agent · needs ${HARNESS_INFO[agent.harness]!.min} locally` : "";
  const navButton = (v: SettingsTab, label: string, icon: ReactNode) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{icon}<span className="set-nav-l">{label}</span></button>;
  return (
    <Modal open={open} onClose={onClose} className="settings-modal">
      <nav className="set-nav">
        <div className="set-nav-h">Settings<span className="hint">⌘,</span></div>
        <div className="set-nav-list" role="tablist" aria-orientation="vertical">
          {SETTINGS_TABS.map(([v, label, icon]) => navButton(v, label, <svg viewBox="0 0 24 24" aria-hidden="true">{icon}</svg>))}
          <div className="set-nav-sec" title={detail.name}>Agents · {detail.name}</div>
          {detail.agents.map((a) => navButton(`agent:${a._id}`, agentLabel(a), <AgentAvatar harness={a.harness} />))}
          {navButton("agent:new", "Add agent", <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>)}
        </div>
        <button className="set-nav-out" onClick={() => void signOut()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9" /></svg>Log out</button>
      </nav>
      <section className="set-main" role="tabpanel" aria-label={title}>
        <div className="set-main-h"><h2>{title}</h2>{sub && <span className="hint">{sub}</span>}<button className="nav-icon" aria-label="Close settings" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
        {agentId === "new" ? <AddAgent detail={detail} onAdded={(id) => setTab(`agent:${id}`)} />
          : agent ? <AgentSettings key={agent._id} a={agent} detail={detail} onDone={onClose} onRemoved={() => setTab("general")} onOpenMachines={() => setTab("machines")} />
          : <>
            <div className="set-body">
              {tab === "general" && <>
                <UsernameSetting name={me.name} login={me.githubLogin} guest={!!me.isAnonymous} />
                <div className="row"><span>Adding people</span><Seg value={u.prefs.addToChat} options={[["auto", "add to the chat right away"], ["ask", "ask me first"]] as const} onChange={(v) => ui.setPref("addToChat", v)} /></div>
                <ResourceSharingPolicy />
                <div className="row"><span>Shortcuts</span><span className="hint">⌘T chat · ⌘⇧T private · ⌘W close · ⌘K jump</span></div>
              </>}
              {tab === "machines" && <Machines pairCode={pairCode ?? null} />}
              {tab === "notifications" && <NotificationSettings />}
              {agentId && <div className="empty" style={{ padding: "16px 14px" }}>That agent is no longer in this workspace.</div>}
            </div>
            <div className="m-f"><span /><button className="btn" onClick={onClose}>Done</button></div>
          </>}
      </section>
    </Modal>
  );
}

function UsernameSetting({ name, login, guest }: { name: string; login: string; guest: boolean }) {
  const save = useMutation(api.users.setUsername);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(name); }, [name]);
  return <form className="row username-setting" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    try { setDraft(await save({ username: draft })); toast("Username saved"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>
    <label htmlFor="beam-username">Username</label>
    <div><div className="username-controls"><input id="beam-username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={33} value={draft} disabled={busy} onChange={e => { setDraft(e.target.value); setError(""); }} aria-describedby="beam-username-help" /><button type="submit" className="btn ghost" disabled={busy || !draft.trim() || draft === name}>{busy ? "Saving…" : "Save"}</button></div>
      <p id="beam-username-help" className="hint">Shown in chats, @mentions, and your agent names. Signed in with GitHub as {login}{guest ? " (guest)" : ""}.</p>
      {error && <p className="connection-error" role="alert">{error}</p>}
    </div>
  </form>;
}

function AddAgent({ detail, onAdded }: { detail: Detail; onAdded: (id: Id<"agents">) => void }) {
  const add = useMutation(api.workspaces.addAgent);
  return <>
    <div className="set-body">
      <div className="list">
        {(["claude", "codex", "omp"] as const).map((h) => {
          const n = detail.agents.filter((x) => x.harness === h).length;
          return <button key={h} onClick={async () => onAdded(await add({ workspaceId: detail.id, harness: h }))}><AgentAvatar harness={h} /><span className="nm">{HARNESS_NAME[h]}<small>{HARNESS_INFO[h]!.vendor}</small></span><span className="d">{n ? `${n} in workspace` : ""}</span></button>;
        })}
      </div>
    </div>
    <div className="m-f"><span>Everyone can choose their own model for the same @agent.</span></div>
  </>;
}

function AgentSettings({ a, detail, onDone, onRemoved, onOpenMachines }: { a: Doc<"agents">; detail: Detail; onDone: () => void; onRemoved: () => void; onOpenMachines: () => void }) {
  const localRunnerId = useLocalRunner();
  const accountPreferences = useQuery(api.connections.preferences);
  const saveAccount = useMutation(api.connections.setPreference);
  const update = useMutation(api.workspaces.updateAgent);
  const preferences = useQuery(api.users.preferences);
  const savePreference = useMutation(api.users.setAgentPreference);
  const myRunners = useQuery(api.runners.mine) ?? [];
  const sharedRunners = useQuery(api.runners.online, { workspaceId: detail.id }) ?? [];
  const [runnerChoice, setRunnerChoice] = useState<string | null>(null);
  const remove = useMutation(api.workspaces.removeAgent);
  const [draft, setDraft] = useState<Partial<Doc<"agents">>>({});
  const info = HARNESS_INFO[a.harness]!;
  const preference = preferences?.find((p) => p.harness === a.harness);
  const v = { ...a, ...(preference ? { model: preference.model, effort: preference.effort } : {}), ...draft };
  const account = accountPreferences?.find(p => p.harness === a.harness) ?? preference;
  const connection = runnerChoice ?? (account?.runnerId ? JSON.stringify([account.runnerId, account.connectionId ?? "default"]) : "");
  const runners = [...myRunners, ...sharedRunners.filter((r) => r.allowSharedRuns && !myRunners.some((m) => m.id === r.id))];
  const selectedChoice = connection ? JSON.parse(connection) as [string, string] : null;
  const selectedRunner = runners.find(r => r.id === (selectedChoice?.[0] ?? localRunnerId));
  const status = HarnessStatus.safeParse(connectionStatuses(selectedRunner?.harnesses).find(h => h.harness === a.harness && (selectedChoice ? h.connectionId === selectedChoice[1] : h.isDefault))).data;
  const catalog = status?.models ?? [];
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
  const selectedModel = catalog.find((m) => normalize(m.model) === normalize(v.model) || normalize(m.name) === normalize(v.model));
  const modelOptions = a.harness === "codex" ? catalog : info.models.map((m) => ({ model: m, name: m, efforts: ["low", "medium", "high", "max"] }));
  const efforts = a.harness === "codex" ? [...new Set([...(selectedModel?.efforts ?? []), "max"])] : ["low", "medium", "high", "max"];
  return <>
    <div className="set-body">
        <div className="row"><span>Name in chat</span><span className="val">@<input type="text" value={v.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value.replace(/[^a-z0-9-]/g, "") })} style={{ width: 140, display: "inline-block", marginLeft: 2 }} /></span></div>
        <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Your defaults · {HARNESS_NAME[a.harness]}</div>
        <div className="row"><span>Preferred account</span><Select label="Preferred account" value={connection} onChange={setRunnerChoice} placeholder="Selected account unavailable" options={[{ value: "", label: "Each machine’s own default" }, ...runners.flatMap(r => connectionStatuses(r.harnesses).filter(h => h.harness === a.harness).map(h => ({ value: JSON.stringify([r.id, h.connectionId]), label: `${h.connectionName}${h.email ? ` · ${h.email}` : ""}`, hint: `${r.name}${r.online ? "" : " · offline"}` })))]} /></div>
        <div className="row"><span>Your model</span><Select label="Your model" value={selectedModel?.model ?? v.model} onChange={(model) => { const m = modelOptions.find((m) => m.model === model); setDraft({ ...draft, model, effort: m?.efforts.includes(v.effort) ? v.effort : m?.efforts[0] ?? "high" }); }}
          options={[...(!modelOptions.some((m) => m.model === v.model || m.model === selectedModel?.model) ? [{ value: v.model, label: v.model, hint: a.harness === "codex" ? "unavailable until refreshed" : "unavailable", disabled: true }] : []), ...modelOptions.map((m) => ({ value: m.model, label: m.name }))]} /></div>
        {a.harness === "codex" && !catalog.length && <div className="row set-note"><span className="hint">Codex models load from a machine’s last check.</span><button className="btn ghost" onClick={onOpenMachines}>Open Machines</button></div>}
        <div className="row"><span>Your reasoning effort</span><Select label="Your reasoning effort" value={v.effort} onChange={(effort) => setDraft({ ...draft, effort })} options={[...(!efforts.includes(v.effort) ? [{ value: v.effort, label: v.effort, hint: "unavailable", disabled: true }] : []), ...efforts.map((e) => ({ value: e, label: e }))]} /></div>
        <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Shared agent settings</div>
        <div className="row"><span>Permissions</span><Seg value={v.permissionMode} options={[["ask", "Supervised"], ["plan", "Plan"], ["auto", "Full access"], ["allowlist", "Allow list"]] as const} onChange={(x) => setDraft({ ...draft, permissionMode: x })} /></div>
        <div className="row"><span>Always allow</span><input type="text" value={v.alwaysAllow.join(", ")} onChange={(e) => setDraft({ ...draft, alwaysAllow: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></div>
        <div className="row"><span>Context on dispatch</span><Seg value={v.contextPolicy} options={[["last-landing", "last landing"], ["since-landing-plus-summary", "since last landing + summary"], ["whole-chat", "whole chat"]] as const} onChange={(x) => setDraft({ ...draft, contextPolicy: x })} /></div>
        <div className="row"><span>Instructions</span><span className="hint">{info.files} from repo root</span></div>
    </div>
    <div className="m-f"><span>Your defaults apply to new runs you request.</span><span><button className="btn ghost" onClick={async () => { if (detail.agents.length <= 1) { toast("Keep at least one agent"); return; } await remove({ agentId: a._id }); onRemoved(); toast("Agent removed from workspace"); }}>Remove</button> <button className="btn" disabled={!preferences} onClick={async () => { try { await savePreference({ harness: a.harness, model: selectedModel?.model ?? v.model, effort: v.effort, ...(preference?.runnerId ? { runnerId: preference.runnerId, ...(preference.connectionId ? { connectionId: preference.connectionId } : {}) } : {}) }); if (runnerChoice !== null) await saveAccount({ harness: a.harness, ...(selectedChoice ? { runnerId: selectedChoice[0] as Id<"runners">, connectionId: selectedChoice[1] } : {}) }); const patch = { ...(draft.handle !== undefined ? { handle: v.handle || a.handle } : {}), ...(draft.permissionMode !== undefined ? { permissionMode: v.permissionMode } : {}), ...(draft.alwaysAllow !== undefined ? { alwaysAllow: v.alwaysAllow } : {}), ...(draft.contextPolicy !== undefined ? { contextPolicy: v.contextPolicy } : {}) }; if (Object.keys(patch).length) await update({ agentId: a._id, patch }); onDone(); toast("Saved · applies to your next run"); } catch (e) { toast((e as Error).message); } }}>Save</button></span></div>
  </>;
}

export function InviteModal({ open, onClose, wsId, wsName, chatId }: { open: boolean; onClose: () => void; wsId: Id<"workspaces">; wsName: string; chatId: Id<"chats"> | null }) {
  const invite = useMutation(api.workspaces.invite);
  const u = useUi();
  const [login, setLogin] = useState("");
  const [sel, setSel] = useState(0);
  const people = useQuery(api.users.directory, open ? { workspaceId: wsId, q: login } : "skip") ?? [];
  useEffect(() => { if (open) { setLogin(""); setSel(0); } }, [open]);
  useEffect(() => { setSel(0); }, [login]);
  const typed = login.trim().replace(/^@/, "");
  const exact = people.some((p) => p.login.toLowerCase() === typed.toLowerCase());
  // Rows: everyone on Beam who matches, plus "invite <typed>" when the typed login is not one of them.
  const rows = [...people.map((p) => ({ kind: "person" as const, ...p })), ...(typed && !exact ? [{ kind: "raw" as const, login: typed, name: typed, image: null }] : [])];
  const go = async (l: string) => {
    if (!l) return;
    const addHere = chatId && (u.prefs.addToChat === "auto" || window.confirm(`Also add ${l} to this chat?`));
    try {
      const done = await invite({ workspaceId: wsId, githubLogin: l, chatId: addHere ? chatId : null });
      onClose(); toast(addHere ? `Invited ${done} · added to this chat too` : `Invited ${done} · the workspace shows up for them right away`);
    } catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); }
  };
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">Invite to {wsName}</div>
      <div className="row"><span>Who</span><input type="text" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="search people on Beam, or type a GitHub login" autoFocus
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (rows.length) setSel((sel + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length); return; }
          if (e.key === "Enter") { e.preventDefault(); const r = rows[sel]; if (r) void go(r.login); }
        }} /></div>
      <div className="repolist">
        {rows.map((r, i) => (
          <button key={r.login} className={`rl-row person${i === sel ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => void go(r.login)}>
            <PersonAvatar login={r.login} name={r.name} image={r.image} hue={hueClass(r.login)} />
            <span className="nm">{r.name}</span>
            <span className="d">{r.kind === "person" ? `@${r.login} · on Beam` : "not on Beam yet · invite by login anyway"}</span>
            <span className="t">{r.kind === "person" ? "invite" : "invite"}</span>
          </button>
        ))}
        {!rows.length && <div className="rl-note">{typed ? "No one matches. Keep typing a full GitHub login to invite them anyway." : "Everyone on Beam is already in this workspace. Type a GitHub login to invite someone new."}</div>}
      </div>
      <div className="m-f"><span>They connect their own harnesses; their machine hosts runs while Beam is open.</span><span><button className="btn ghost" onClick={onClose}>Cancel</button></span></div>
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
  const myRepos = useAction(api.github.myRepos);
  const [repo, setRepoV] = useState("");
  const [list, setList] = useState<{ repos: { name: string; private: boolean; pushedAt: number; description: string | null }[] | null; reason: string | null } | "loading">("loading");
  const load = () => myRepos({}).then((r) => setList(r), () => setList({ repos: null, reason: "github-error" }));
  useEffect(() => {
    if (!open) return;
    setRepoV(""); setList("loading");
    void load();
  }, [open]);
  // No token yet: keep asking every few seconds so the list appears the moment GitHub is connected in the browser.
  const needsConnect = list !== "loading" && !list.repos && (list.reason === "no-token" || list.reason === "no-scope");
  useEffect(() => {
    if (!open || !needsConnect) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [open, needsConnect]);
  const connectGitHub = () => {
    const url = `${HOSTED_URL}/?connect=github`;
    const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam;
    if (b?.openExternal) b.openExternal(url); else window.open(url, "_blank", "noopener");
    toast("Allow repo access in your browser · this list fills in by itself");
  };
  const connect = async (name: string) => {
    const r = name.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) { toast("owner/name, please"); return; }
    await addRepo({ workspaceId: wsId, repo: r });
    if (chatId) await setRepo({ chatId, repo: r }).catch(() => {});
    onClose(); toast(`${r} connected`);
  };
  const q = repo.trim().toLowerCase();
  const rows = list !== "loading" && list.repos ? list.repos.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 12) : [];
  const ago = (t: number) => { const d = Math.max(0, Date.now() - t); const h = d / 3.6e6; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)}h ago` : h < 24 * 30 ? `${Math.round(h / 24)}d ago` : `${Math.round(h / 24 / 30)}mo ago`; };
  return (
    <Modal open={open} onClose={onClose}>
      <div className="m-h">Connect a repo to {wsName}</div>
      <div className="row"><span>Repo</span><input type="text" value={repo} onChange={(e) => setRepoV(e.target.value)} placeholder={list !== "loading" && list.repos ? "filter your repos, or paste owner/name" : "owner/name or GitHub URL"} autoFocus onKeyDown={(e) => { if (e.key === "Enter") void connect(rows.length && !/\//.test(repo) ? rows[0]!.name : repo); }} /></div>
      <div className="repolist">
        {list === "loading" && <div className="rl-note">Loading your GitHub repos…</div>}
        {list !== "loading" && list.repos && rows.map((r) => <button key={r.name} className="rl-row" onClick={() => void connect(r.name)}><span className="nm">{r.name}</span>{r.private && <span className="k">private</span>}<span className="d">{r.description ?? ""}</span><span className="t">{ago(r.pushedAt)}</span></button>)}
        {list !== "loading" && list.repos && !rows.length && <div className="rl-note">{q ? "No repo matches. Paste owner/name to connect one you cannot see here." : "No repos you can push to."}</div>}
        {needsConnect && <div className="rl-connect"><span>Let Beam see your GitHub repos to pick from a list. Read-only listing; pushes still go through your own git.</span><button className="btn" onClick={connectGitHub}>Connect GitHub</button></div>}
        {list !== "loading" && !list.repos && !needsConnect && <div className="rl-note">GitHub did not answer. Paste owner/name instead.</div>}
      </div>
      <div className="m-f"><span>Cloned once per runner, then worktrees per chat.</span><span><button className="btn ghost" onClick={onClose}>Cancel</button> <button className="btn" onClick={() => void connect(repo)}>Connect</button></span></div>
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
