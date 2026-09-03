import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceRow } from "../App";
import { useDocumentTitle } from "../App";
import { bridge } from "../bridge";
import { ui, useUi } from "../lib/ui";
import { ChatView } from "./ChatView";
import { AgentSettingsModal, InviteModal, NewWorkspaceModal, Palette, SettingsModal, AddRepoModal } from "./Modals";
import { Sidebar } from "./Sidebar";
import { People } from "./People";
import { TabStrip } from "./TabStrip";
import { toast } from "./Toast";

export type Me = { id: Id<"users">; name: string; githubLogin: string; image: string | null; isAnonymous: boolean };
export type ModalKind = null | { kind: "settings" } | { kind: "agent"; id: Id<"agents"> } | { kind: "invite" } | { kind: "newws" } | { kind: "addrepo" } | { kind: "palette" };

export function Shell({ me, workspaces }: { me: Me; workspaces: WorkspaceRow[] }) {
  const u = useUi();
  const wsId = (workspaces.find((w) => w.id === u.ws)?.id ?? workspaces[0]!.id) as Id<"workspaces">;
  useEffect(() => { if (u.ws !== wsId) ui.setWorkspace(wsId); }, [u.ws, wsId]);
  // Keep the last loaded workspace on screen while the next one loads, so switching never unmounts the shell.
  const liveDetail = useQuery(api.workspaces.detail, { workspaceId: wsId });
  const liveChats = useQuery(api.chats.list, { workspaceId: wsId });
  const last = useRef<{ ws: string; detail: NonNullable<typeof liveDetail>; chats: NonNullable<typeof liveChats> } | null>(null);
  if (liveDetail && liveChats) last.current = { ws: wsId, detail: liveDetail, chats: liveChats };
  const detail = liveDetail ?? last.current?.detail;
  const chats = liveChats ?? (last.current ? [] : undefined);
  const presence = useQuery(api.presence.inWorkspace, { workspaceId: wsId });
  const createChat = useMutation(api.chats.create);
  const focus = useMutation(api.presence.focus);
  const [modal, setModal] = useState<ModalKind>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const runnersOnline = useQuery(api.runners.online, { workspaceId: wsId });
  const approveRunner = useMutation(api.runnerAuth.approve);
  useEffect(() => {
    // A ?pair= link is a runner on another machine: show the code for a deliberate approval.
    const fromUrl = new URLSearchParams(location.search).get("pair");
    if (fromUrl) { setPairCode(fromUrl.toUpperCase()); setModal({ kind: "settings" }); history.replaceState(null, "", location.pathname); }
    const b = bridge();
    if (!b) return;
    // The runner this app launched is ours: approve it the moment we are signed in, no code shown.
    const auto = (code: string) => approveRunner({ userCode: code }).then((r) => toast(r.already ? "Runner connected" : `Runner ${r.name} connected`)).catch(() => { setPairCode(code); setModal({ kind: "settings" }); });
    void b.runnerStatus().then((s) => { if (s.pendingPair) void auto(s.pendingPair); });
    return b.onPairCode((code) => void auto(code));
  }, [approveRunner]);

  const tabs = useMemo(() => (u.tabs[wsId] ?? []).filter((id) => chats?.some((c) => c._id === id)), [u.tabs, wsId, chats]);
  const activeId = (u.active[wsId] && tabs.includes(u.active[wsId]!) ? u.active[wsId] : tabs[0]) ?? null;
  const active = chats?.find((c) => c._id === activeId) ?? null;
  useDocumentTitle(active ? `${active.title} · Beam` : "Beam");

  // presence: one focused chat per person, heartbeat every 45s
  useEffect(() => {
    void focus({ workspaceId: wsId, chatId: (activeId as Id<"chats"> | null) ?? null });
    const t = setInterval(() => void focus({ workspaceId: wsId, chatId: (activeId as Id<"chats"> | null) ?? null }), 45_000);
    return () => clearInterval(t);
  }, [wsId, activeId, focus]);

  const newChat = useCallback(async (kind: "team" | "private") => {
    const id = await createChat({ workspaceId: wsId, isPrivate: kind === "private" });
    ui.openChat(wsId, id);
    if (kind === "private") toast("Private chat · first agent pinned as default, change it in the composer");
  }, [createChat, wsId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") { e.preventDefault(); setModal({ kind: "palette" }); }
      else if (mod && e.key === "t") { e.preventDefault(); void newChat(e.shiftKey ? "private" : (detail && detail.members.length > 1 ? "team" : "private")); }
      else if (mod && e.key === "w") { e.preventDefault(); if (activeId) ui.closeChat(wsId, activeId); }
      else if (mod && e.key === ",") { e.preventDefault(); setModal({ kind: "settings" }); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [newChat, activeId, wsId, detail]);

  if (!detail || !chats) return <div className="signin"><div className="k">…</div></div>;
  const logins = new Set<string>([...detail.members, ...chats.flatMap((c) => c.members)]);

  return (
    <div className={`app${bridge() ? "" : " browser"}`}>
      <Sidebar me={me} workspaces={workspaces} wsId={wsId} detail={detail} chats={chats} presence={presence ?? []} runners={runnersOnline ?? []} tabs={tabs} activeId={activeId} onNewChat={newChat} setModal={setModal} />
      <div className="pane">
        <div className="titlebar">
          <div className="tb-ws"><b>{detail.name}</b><span className="mono">{detail.repos.length} repo{detail.repos.length === 1 ? "" : "s"}</span></div>
          <div className="tb-r"><People me={me} members={detail.members} presence={presence ?? []} runners={runnersOnline ?? []} setModal={setModal} /><button className="tb-k" onClick={() => setModal({ kind: "palette" })} title="Jump to chat">⌘K</button></div>
        </div>
        <TabStrip wsId={wsId} chats={chats} tabs={tabs} activeId={activeId} onNew={() => void newChat(detail.members.length > 1 ? "team" : "private")} />
        <div className="pane-body">
          {active ? <ChatView key={active._id} me={me} chat={active} detail={detail} logins={logins} setModal={setModal} /> : <EmptyPane />}
        </div>
      </div>
      <SettingsModal open={modal?.kind === "settings"} onClose={() => { setModal(null); setPairCode(null); }} me={me} pairCode={pairCode} />
      <AgentSettingsModal open={modal?.kind === "agent"} agentId={modal?.kind === "agent" ? modal.id : null} detail={detail} onClose={() => setModal(null)} />
      <InviteModal open={modal?.kind === "invite"} onClose={() => setModal(null)} wsId={wsId} wsName={detail.name} chatId={active && !active.private ? active._id : null} />
      <NewWorkspaceModal open={modal?.kind === "newws"} onClose={() => setModal(null)} />
      <AddRepoModal open={modal?.kind === "addrepo"} onClose={() => setModal(null)} wsId={wsId} wsName={detail.name} chatId={active?._id ?? null} />
      <Palette open={modal?.kind === "palette"} onClose={() => setModal(null)} workspaces={workspaces} />
    </div>
  );
}

function EmptyPane() {
  return (
    <main className="thread">
      <div className="thead"><span className="t">No chat open</span></div>
      <div className="msgs"><div className="empty"><b>Pick a chat on the left, or start one.</b><span>⌘T starts a new chat. It gets a branch when the first agent is dispatched.</span></div></div>
    </main>
  );
}
