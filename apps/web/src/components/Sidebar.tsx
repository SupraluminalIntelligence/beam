import beamLogo from "../assets/beam-logo.png";
import { Notifications } from "./Notifications";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceRow } from "../App";
import { hueClass } from "../lib/format";
import { ui, useUi } from "../lib/ui";
import { AgentAvatar, ICO, PersonAvatar } from "./Avatar";
import type { Me, ModalKind } from "./Shell";
import { toast } from "./Toast";
import { PERMISSION_MODES as MODES, PermissionIcon, permissionLabel } from "./Permissions";
import { AgentModelSelect } from "./AgentModelSelect";
import { UpdatePill } from "./Update";
import { AccountMenu } from "./AccountMenu";
import { useChangelogUnseen } from "../lib/changelog";
import { ChatContextMenu, type ChatMenuTarget } from "./ChatContextMenu";

type Detail = NonNullable<ReturnType<typeof useDetailType>>;
function useDetailType() { return null as null | { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] }; }
type RunnerRow = { id: unknown; name: string; ownerLogin: string; online: boolean; harnesses: unknown };
type Status = { harness: string; installed: boolean; auth: string };

const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };


export function Sidebar(p: { me: Me; workspaces: WorkspaceRow[]; wsId: Id<"workspaces">; detail: Detail; chats: Doc<"chats">[]; presence: { login: string; chatId: Id<"chats"> | null }[]; runners: RunnerRow[]; tabs: string[]; activeId: string | null; onNewChat: (k: "team" | "private") => void; setModal: (m: ModalKind) => void }) {
  const [newPop, setNewPop] = useState<string | null>(null);
  const [chatMenu, setChatMenu] = useState<ChatMenuTarget | null>(null);
  const closeChatMenu = useCallback(() => setChatMenu(null), []);
  const [acct, setAcct] = useState(false);
  const unseen = useChangelogUnseen();
  const [openSel, setOpenSel] = useState<string | null>(null);
  const updateAgent = useMutation(api.workspaces.updateAgent);
  const people = useQuery(api.users.byLogins, { logins: p.detail.members });
  const nameOf = (l: string) => (l === p.me.githubLogin ? p.me.name : people?.[l]?.name ?? l);
  const imageOf = (l: string) => (l === p.me.githubLogin ? p.me.image : people?.[l]?.image ?? null);
  useEffect(() => {
    const close = () => { setNewPop(null); setAcct(false); setOpenSel(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const ui_ = useUi();
  const resize = useRef<{ x: number; width: number } | null>(null);
  const endResize = () => { resize.current = null; document.body.classList.remove("resizing"); };
  useEffect(() => {
    if (ui_.sidebarHidden) endResize();
    return endResize;
  }, [ui_.sidebarHidden]);
  const [showDone, setShowDone] = useState(false);
  const rename = useMutation(api.workspaces.rename);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const commitRename = async () => {
    if (!renaming) return;
    const { id, value } = renaming; setRenaming(null);
    const w = p.workspaces.find((x) => x.id === id);
    if (!w || value.trim() === w.name || !value.trim()) return;
    try { await rename({ workspaceId: id as Id<"workspaces">, name: value }); toast(`Renamed to ${value.trim()}`); }
    catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); }
  };
  const harnessReady = (h: string) => p.runners.some((r) => r.online && ((r.harnesses as Status[] | null) ?? []).some((s) => s.harness === h && s.installed && s.auth === "authenticated"));

  return (
    <aside className="side" inert={ui_.sidebarHidden} aria-hidden={ui_.sidebarHidden}>
      <div className="side-grip" title="Drag to resize" onPointerDown={(e) => {
        if (e.button !== 0 || ui_.sidebarHidden) return;
        e.preventDefault();
        resize.current = { x: e.clientX, width: ui.get().sidebarWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
      }} onPointerMove={(e) => {
        if (!resize.current) return;
        if (!(e.buttons & 1) || ui.get().sidebarHidden) { endResize(); return; }
        ui.setSidebarWidth(resize.current.width + e.clientX - resize.current.x);
      }} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} />
      <div className="sb-top" />
      <div className="sb-brand-row"><span className="sb-brand"><img src={beamLogo} alt="" />Beam</span><button className="nav-icon" title="Search chats (⌘K)" aria-label="Search chats" onClick={() => p.setModal({ kind: "palette" })}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button><Notifications key={p.me.id} activeChat={p.activeId} /></div>
      <div className="ws-row top" onClick={stop}>
        <button className="sb-act" onClick={() => setNewPop(newPop === "top" ? null : "top")}>+ New chat <span className="k">⌘T</span></button>
        <NewPop open={newPop === "top"} wsName={p.detail.name} onPick={(k) => { setNewPop(null); p.onNewChat(k); }} />
      </div>
      <div className="sb-scroll">
        {(ui_.pinnedChats[p.me.id] ?? []).some(pin => p.workspaces.some(w => w.id === pin.workspaceId)) && <section className="sb-pinned" aria-label="Pinned chats">
          <div className="sb-sec">Pinned</div>
          {(ui_.pinnedChats[p.me.id] ?? []).filter(pin => p.workspaces.some(w => w.id === pin.workspaceId)).map(pin => <PinnedChat key={pin.chatId} pin={pin} activeId={p.activeId} wsId={p.wsId} onContextMenu={setChatMenu} />)}
        </section>}
        <div className="sb-sec">Workspaces <button onClick={() => p.setModal({ kind: "newws" })} title="New workspace">+</button></div>
        {p.workspaces.map((w) => {
          const on = w.id === p.wsId;
          const folded = !!ui_.collapsed[w.id];
          return (
            <div key={w.id}>
              <div className={`ws-row${on ? " on" : ""}`} onClick={stop}>
                <button
                  className="ws-fold"
                  onClick={() => ui.toggleCollapsed(w.id)}
                  aria-label={`${folded ? "Expand" : "Collapse"} ${w.name}`}
                  aria-expanded={!folded}
                  aria-controls={`workspace-threads-${w.id}`}
                  title={`${folded ? "Expand" : "Collapse"} ${w.name}`}
                >
                  <svg className="ws-folder" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {folded
                      ? <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18" />
                      : <><path d="M3 19V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2" /><path d="M3 19a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4L23 10H8a2 2 0 0 0-1.9 1.4L3 19Z" /></>}
                  </svg>
                </button>
                <button className={`ws-item${on ? " on" : ""}`} onClick={() => ui.setWorkspace(w.id)} onDoubleClick={() => setRenaming({ id: w.id, value: w.name })} title="Double-click to rename">
                  {renaming?.id === w.id
                    ? <input className="nm ws-rename" autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: w.id, value: e.target.value })} onBlur={() => void commitRename()} onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitRename(); } if (e.key === "Escape") setRenaming(null); }} />
                    : <span className="nm">{w.name}</span>}
                </button>
                <button className="ws-plus" onClick={() => setNewPop(newPop === w.id ? null : w.id)} title={`New chat in ${w.name}`}>+</button>
                <NewPop open={newPop === w.id} wsName={w.name} onPick={(k) => { setNewPop(null); ui.setWorkspace(w.id); p.onNewChat(k); }} />
              </div>
              <div id={`workspace-threads-${w.id}`} className={`wt-wrap${folded ? " closed" : ""}`} inert={folded} aria-hidden={folded}><div className="wt-inner">
                <WorkspaceThreads wsId={w.id as Id<"workspaces">} active={on} p={p} showDone={showDone} setShowDone={setShowDone} nameOf={nameOf} imageOf={imageOf} onContextMenu={setChatMenu} />
              </div></div>
            </div>
          );
        })}
      </div>
      <div className="sb-bottom">
        <div className="sb-sec">Agents <button onClick={() => p.setModal({ kind: "agent", id: "new" as unknown as Id<"agents"> })} title="Add an agent: omp, Gemini CLI, or any harness with a JSON stream">+</button></div>
        {p.detail.agents.map((a) => (
          <div key={a._id} className="ag-item" onClick={stop}>
            <button className="ag-name" onClick={() => p.setModal({ kind: "agent", id: a._id })} title="Agent settings"><AgentAvatar harness={a.harness} /><span className="nm">{HARNESS_NAME[a.harness] ?? a.harness}{a.handle !== a.harness && <> <span className="k">@{a.handle}</span></>}</span></button>
            <span className={`sq ${harnessReady(a.harness) ? "ok" : "idle"}`} title={harnessReady(a.harness) ? "a runner is online with this harness signed in" : "no online runner has this harness signed in"} />
            <span className="sub ctls">
              <AgentModelSelect agent={a} />
              <span className={`sel ctl mode m-${a.permissionMode}${openSel === `${a._id}:mode` ? " open" : ""}`} tabIndex={0} title={`${(MODES.find((m) => m.v === a.permissionMode) ?? MODES[0]).hint}`} onClick={() => setOpenSel(openSel === `${a._id}:mode` ? null : `${a._id}:mode`)}>
                <PermissionIcon mode={a.permissionMode} /><span>{permissionLabel(a.permissionMode)}</span><i>▾</i>
                <span className="dd wide"><span className="ddh">how it works</span>{MODES.map((m) => <button key={m.v} className={m.v === a.permissionMode ? "on" : ""} onClick={(e) => { e.stopPropagation(); setOpenSel(null); void updateAgent({ agentId: a._id, patch: { permissionMode: m.v } }); toast(`${HARNESS_NAME[a.harness]} → ${m.label} · next run`); }}><b>{m.label}</b><span>{m.hint.replace(/^\w+: /, "")}</span></button>)}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
      <div className="sb-foot" onClick={stop}>
        <AccountMenu me={p.me} open={acct} workspaceName={p.detail.name} onClose={() => setAcct(false)} onSettings={(tab) => p.setModal(tab ? { kind: "settings", tab } : { kind: "settings" })} onInvite={() => p.setModal({ kind: "invite" })} />
        <div className="acct-row"><button className="acct" onClick={() => setAcct(!acct)} aria-haspopup="menu" aria-expanded={acct}><PersonAvatar login={p.me.githubLogin} name={p.me.name} image={p.me.image} hue="me" /><span className="nm">{p.me.name}</span>{unseen && <span className="news-dot" aria-label="What's new" />}<span className="k">⚙</span></button><UpdatePill /></div>
      </div>
      {chatMenu && <ChatContextMenu key={chatMenu.chat._id} target={chatMenu} onClose={closeChatMenu} userId={p.me.id} />}
    </aside>
  );
}

function NewPop({ open, wsName, onPick }: { open: boolean; wsName: string; onPick: (k: "team" | "private") => void }) {
  return (
    <div className="newpop" hidden={!open}>
      <button onClick={() => onPick("team")}>{ICO.team}<span>Team chat<small>starts with just you · invite from the header</small></span></button>
      <button onClick={() => onPick("private")}>{ICO.lock}<span>Private chat<small>just you · @mention an agent</small></span></button>
      <span className="k" style={{ display: "none" }}>{wsName}</span>
    </div>
  );
}

/** One workspace's threads. Every workspace keeps its list; only the active one shows presence. Double-click a thread to rename it. */
function WorkspaceThreads({ wsId, active, p, showDone, setShowDone, nameOf, imageOf, onContextMenu }: { wsId: Id<"workspaces">; active: boolean; p: { me: Me; chats: Doc<"chats">[]; presence: { login: string; chatId: Id<"chats"> | null }[]; tabs: string[]; activeId: string | null }; showDone: boolean; setShowDone: (v: boolean) => void; nameOf: (l: string) => string; imageOf: (l: string) => string | null; onContextMenu: (target: ChatMenuTarget) => void }) {
  const own = useQuery(api.chats.list, active ? "skip" : { workspaceId: wsId });
  const chats = active ? p.chats : own ?? [];
  const renameChat = useMutation(api.chats.rename);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const commit = async () => {
    if (!renaming) return;
    const { id, value } = renaming; setRenaming(null);
    const c = chats.find((x) => x._id === id);
    if (!c || !value.trim() || value.trim() === c.title) return;
    try { await renameChat({ chatId: id as Id<"chats">, title: value.trim().slice(0, 80) }); } catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); }
  };
  const status = (c: Doc<"chats">) => (c.state && c.state !== "open" ? "settled" : "idle");
  const open = chats.filter((c) => !c.state || c.state === "open"), settled = chats.filter((c) => c.state && c.state !== "open");
  return (
    <>
      {[...open, ...(showDone && active ? settled : [])].map((c) => {
        const here = active ? p.presence.filter((x) => x.chatId === c._id).map((x) => x.login) : [];
        return (
          <button key={c._id} className={`th-item${active && p.tabs.includes(c._id) ? " open" : ""}${active && p.activeId === c._id ? " on" : ""}`} onClick={() => ui.openChat(wsId, c._id)} onDoubleClick={() => setRenaming({ id: c._id, value: c.title })} title="Double-click to rename · Right-click for options"
            onContextMenu={e => {
              if (e.target instanceof HTMLInputElement) return;
              e.preventDefault(); e.stopPropagation();
              const bounds = e.currentTarget.getBoundingClientRect();
              onContextMenu({ chat: c, x: e.clientX || bounds.left + 24, y: e.clientY || bounds.bottom, trigger: e.currentTarget });
            }}>
            <span className={`sq ${status(c)}`} />
            {renaming?.id === c._id
              ? <input className="nm th-rename" autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: c._id, value: e.target.value })} onBlur={() => void commit()} onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } if (e.key === "Escape") setRenaming(null); }} />
              : <span className={`nm${c.untitled ? " untitled" : ""}`}>{c.title}</span>}
            {c.private && <span className="lk" title="Private · only you">{ICO.lock}</span>}
            <span className="here" title={here.length ? `${here.map(nameOf).join(", ")} focused here` : ""}>{here.map((l) => <PersonAvatar key={l} login={l} name={nameOf(l)} image={imageOf(l)} hue={l === p.me.githubLogin ? "me" : hueClass(l)} className="xs" />)}</span>
          </button>
        );
      })}
      {active && settled.length > 0 && <button className="th-done" onClick={() => setShowDone(!showDone)}>{showDone ? "▾" : "▸"} {settled.length} settled</button>}
    </>
  );
}

function PinnedChat({ pin, activeId, wsId, onContextMenu }: { pin: { workspaceId: string; chatId: string }; activeId: string | null; wsId: string; onContextMenu: (target: ChatMenuTarget) => void }) {
  const chats = useQuery(api.chats.list, { workspaceId: pin.workspaceId as Id<"workspaces"> });
  const chat = chats?.find(c => c._id === pin.chatId);
  if (!chat) return null;
  return <button className={`th-item pinned-chat${activeId === chat._id && wsId === pin.workspaceId ? " on" : ""}`} onClick={() => ui.openChat(pin.workspaceId, chat._id)} title={chat.title} onContextMenu={e => {
    e.preventDefault(); e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onContextMenu({ chat, x: e.clientX || rect.left + 24, y: e.clientY || rect.bottom, trigger: e.currentTarget });
  }}><span className={`nm${chat.untitled ? " untitled" : ""}`}>{chat.title}</span>{chat.private && <span className="lk" title="Private">{ICO.lock}</span>}</button>;
}
