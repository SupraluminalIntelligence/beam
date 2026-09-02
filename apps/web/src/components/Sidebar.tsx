import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceRow } from "../App";
import { hueClass } from "../lib/format";
import { ui } from "../lib/ui";
import { AgentAvatar, ICO, PersonAvatar } from "./Avatar";
import type { Me, ModalKind } from "./Shell";
import { toast } from "./Toast";

type Detail = NonNullable<ReturnType<typeof useDetailType>>;
function useDetailType() { return null as null | { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] }; }
type RunnerRow = { id: unknown; name: string; ownerLogin: string; online: boolean; harnesses: unknown };
type Status = { harness: string; installed: boolean; auth: string };

const EFFORTS = ["low", "medium", "high", "max"] as const;
/** Claude Code's three ways of working. Codex and omp map onto the same three in M3. */
const MODES = [
  { v: "ask", label: "ask", hint: "Ask: risky actions wait for approval in the chat" },
  { v: "plan", label: "plan", hint: "Plan: read-only until the plan is approved" },
  { v: "auto", label: "auto", hint: "Auto: approves routine actions, asks about the rest" },
] as const;
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const MODELS: Record<string, string[]> = { claude: ["Fable 5.1", "Fable 5.0", "Opus 5.0", "Sonnet 5.0"], codex: ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"], omp: ["GPT-5.6 Sol", "Kimi K3", "Gemini 3.5 Pro", "Claude Opus 5 (API key)"] };

export function Sidebar(p: { me: Me; workspaces: WorkspaceRow[]; wsId: Id<"workspaces">; detail: Detail; chats: Doc<"chats">[]; presence: { login: string; chatId: Id<"chats"> | null }[]; runners: RunnerRow[]; tabs: string[]; activeId: string | null; onNewChat: (k: "team" | "private") => void; setModal: (m: ModalKind) => void }) {
  const [newPop, setNewPop] = useState<string | null>(null);
  const [acct, setAcct] = useState(false);
  const [openSel, setOpenSel] = useState<string | null>(null);
  const updateAgent = useMutation(api.workspaces.updateAgent);
  const { signOut } = useAuthActions();
  const people = useQuery(api.users.byLogins, { logins: p.detail.members });
  const nameOf = (l: string) => (l === p.me.githubLogin ? p.me.name : people?.[l]?.name ?? l);
  const imageOf = (l: string) => (l === p.me.githubLogin ? p.me.image : people?.[l]?.image ?? null);
  useEffect(() => {
    const close = () => { setNewPop(null); setAcct(false); setOpenSel(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const status = (_c: Doc<"chats">) => "idle";
  const harnessReady = (h: string) => p.runners.some((r) => r.online && ((r.harnesses as Status[] | null) ?? []).some((s) => s.harness === h && s.installed && s.auth === "authenticated"));
  const runnersOf = (login: string) => p.runners.filter((r) => r.online && r.ownerLogin === login);

  return (
    <aside className="side">
      <div className="sb-top"><span className="sb-brand">BEAM</span></div>
      <div className="ws-row top" onClick={stop}>
        <button className="sb-act" onClick={() => setNewPop(newPop === "top" ? null : "top")}>+ New chat <span className="k">⌘T</span></button>
        <NewPop open={newPop === "top"} wsName={p.detail.name} onPick={(k) => { setNewPop(null); p.onNewChat(k); }} />
      </div>
      <div className="sb-scroll">
        <div className="sb-sec">Workspaces <button onClick={() => p.setModal({ kind: "newws" })} title="New workspace">+</button></div>
        {p.workspaces.map((w) => {
          const on = w.id === p.wsId;
          return (
            <div key={w.id}>
              <div className={`ws-row${on ? " on" : ""}`} onClick={stop}>
                <button className={`ws-item${on ? " on" : ""}`} onClick={() => ui.setWorkspace(w.id)}><span className="ic">{on ? "▣" : "▢"}</span><span className="nm">{w.name}</span><span className="k">{on ? p.chats.length : ""}</span></button>
                <button className="ws-plus" onClick={() => setNewPop(newPop === w.id ? null : w.id)} title={`New chat in ${w.name}`}>+</button>
                <NewPop open={newPop === w.id} wsName={w.name} onPick={(k) => { setNewPop(null); ui.setWorkspace(w.id); p.onNewChat(k); }} />
              </div>
              {on && p.chats.map((c) => {
                const here = p.presence.filter((x) => x.chatId === c._id).map((x) => x.login);
                return (
                  <button key={c._id} className={`th-item${p.tabs.includes(c._id) ? " open" : ""}${p.activeId === c._id ? " on" : ""}`} onClick={() => ui.openChat(p.wsId, c._id)}>
                    <span className={`sq ${status(c)}`} />
                    <span className={`nm${c.untitled ? " untitled" : ""}`}>{c.title}</span>
                    {c.private && <span className="lk" title="Private · only you">{ICO.lock}</span>}
                    <span className="here" title={here.length ? `${here.map(nameOf).join(", ")} focused here` : ""}>{here.map((l) => <PersonAvatar key={l} login={l} name={nameOf(l)} image={imageOf(l)} hue={l === p.me.githubLogin ? "me" : hueClass(l)} className="xs" />)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        <div className="sb-sec">Agents <button onClick={() => p.setModal({ kind: "agent", id: "new" as unknown as Id<"agents"> })} title="Add an agent: omp, Gemini CLI, or any harness with a JSON stream">+</button></div>
        {p.detail.agents.map((a) => (
          <div key={a._id} className="ag-item" onClick={stop}>
            <button className="ag-name" onClick={() => p.setModal({ kind: "agent", id: a._id })} title="Agent settings"><AgentAvatar harness={a.harness} /><span className="nm">{HARNESS_NAME[a.harness] ?? a.harness}{a.handle !== a.harness && <> <span className="k">@{a.handle}</span></>}</span></button>
            <span className={`sq ${harnessReady(a.harness) ? "ok" : "idle"}`} title={harnessReady(a.harness) ? "a runner is online with this harness signed in" : "no online runner has this harness signed in"} />
            <span className="sub ctls">
              <span className={`sel ctl${openSel === a._id ? " open" : ""}`} tabIndex={0} title="Model · next run" onClick={() => setOpenSel(openSel === a._id ? null : a._id)}>
                <span>{a.model}</span><i>▾</i>
                <span className="dd"><span className="ddh">model</span>{(MODELS[a.harness] ?? []).map((m) => <button key={m} className={m === a.model ? "on" : ""} onClick={(e) => { e.stopPropagation(); setOpenSel(null); void updateAgent({ agentId: a._id, patch: { model: m } }); toast(`${HARNESS_NAME[a.harness]} → ${m} · next run`); }}>{m}</button>)}</span>
              </span>
              <span className="dot">·</span>
              <span className={`sel ctl mode ${a.permissionMode}${openSel === `${a._id}:mode` ? " open" : ""}`} tabIndex={0} title={`${(MODES.find((m) => m.v === a.permissionMode) ?? MODES[0]).hint}`} onClick={() => setOpenSel(openSel === `${a._id}:mode` ? null : `${a._id}:mode`)}>
                <span>{(MODES.find((m) => m.v === a.permissionMode) ?? { label: a.permissionMode }).label}</span><i>▾</i>
                <span className="dd wide"><span className="ddh">how it works</span>{MODES.map((m) => <button key={m.v} className={m.v === a.permissionMode ? "on" : ""} onClick={(e) => { e.stopPropagation(); setOpenSel(null); void updateAgent({ agentId: a._id, patch: { permissionMode: m.v } }); toast(`${HARNESS_NAME[a.harness]} → ${m.label} · next run`); }}><b>{m.label}</b><span>{m.hint.replace(/^\w+: /, "")}</span></button>)}</span>
              </span>
              <span className="dot">·</span>
              <button className="ctl eff" data-lv={EFFORTS.indexOf(a.effort as typeof EFFORTS[number]) + 1} title="Reasoning effort · click to change" onClick={() => { const n = EFFORTS[(EFFORTS.indexOf(a.effort as typeof EFFORTS[number]) + 1) % 4]!; void updateAgent({ agentId: a._id, patch: { effort: n } }); toast(`${HARNESS_NAME[a.harness]} effort → ${n}`); }}><span className="bars"><i /><i /><i /><i /></span><span>{a.effort}</span></button>
            </span>
          </div>
        ))}
        <div className="sb-sec">People <button onClick={() => p.setModal({ kind: "invite" })} title="Invite a member by GitHub login">+</button></div>
        {p.detail.members.map((l) => {
          const online = p.presence.some((x) => x.login === l);
          return (
            <button key={l} className="pp-item" onClick={() => toast(`${l} · ${online ? "online" : "away"}`)}>
              <PersonAvatar login={l} name={nameOf(l)} image={imageOf(l)} hue={l === p.me.githubLogin ? "me" : hueClass(l)} />
              <span className="nm">{nameOf(l)}</span>
              <span className={`sq ${online ? "ok" : "idle"}`} />
              <span className="sub">{[l === p.me.githubLogin ? "you" : online ? "online" : "away", ...(runnersOf(l).length ? [`runner · ${runnersOf(l).map((r) => r.name).join(", ")}`] : [])].join(" · ")}</span>
            </button>
          );
        })}
      </div>
      <div className="sb-foot" onClick={stop}>
        <div className="menu" hidden={!acct}>
          <div className="mh"><PersonAvatar login={p.me.githubLogin} name={p.me.name} image={p.me.image} hue="me" /><div><div className="mn">{p.me.name}</div><div className="k">{p.me.githubLogin}{p.me.isAnonymous ? " · guest" : ""}</div></div></div>
          <button onClick={() => { setAcct(false); toast("Usage: wired in M1 from the harness probes"); }}><span>Usage this month</span><span className="k">M1</span></button>
          <button onClick={() => { setAcct(false); p.setModal({ kind: "settings" }); }}><span>Connected harnesses</span><span className="k">M1</span></button>
          <button onClick={() => { setAcct(false); p.setModal({ kind: "invite" }); }}><span>Invite a teammate</span></button>
          <button onClick={() => { setAcct(false); p.setModal({ kind: "settings" }); }}><span>Settings</span><span className="k">⌘,</span></button>
          <button onClick={() => void signOut()}><span>Log out</span></button>
        </div>
        <button className="acct" onClick={() => setAcct(!acct)} aria-haspopup="menu" aria-expanded={acct}><PersonAvatar login={p.me.githubLogin} name={p.me.name} image={p.me.image} hue="me" /><span className="nm">{p.me.name}</span><span className="k">⚙</span></button>
      </div>
    </aside>
  );
}

function NewPop({ open, wsName, onPick }: { open: boolean; wsName: string; onPick: (k: "team" | "private") => void }) {
  return (
    <div className="newpop" hidden={!open}>
      <button onClick={() => onPick("team")}>{ICO.team}<span>Team chat<small>starts with just you · invite from the header</small></span></button>
      <button onClick={() => onPick("private")}>{ICO.lock}<span>Private chat<small>just you · pin a default agent</small></span></button>
      <span className="k" style={{ display: "none" }}>{wsName}</span>
    </div>
  );
}
