import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { dayLabel, firstMention, hhmm, hueClass } from "../lib/format";
import { ui, useUi } from "../lib/ui";
import { StudyCard, StudyContext } from "../simulation/Study";
import { JobCard } from "./Compute";
import { useSmoothText } from "../lib/smooth";
import { Markdown } from "./Markdown";
import { AgentAvatar, ICO, PersonAvatar } from "./Avatar";
import { Modal, Seg } from "./Modal";
import { fold, timeline, type RunView } from "@beam/reducer";
import { Activity, LandingCard, Requests, RunStatus, isLive } from "./RunBlocks";
import type { Me, ModalKind } from "./Shell";
import { toast } from "./Toast";
import { TypingIndicator, useTyping } from "./TypingIndicator";
import { RunAttribution } from "./RunAttribution";
import { useFileDrop } from "../lib/fileDrop";
import { useFollowScroll } from "../lib/followScroll";
import { MessageFiles, useAttachments } from "./Files";
import { ComposerPermissions } from "./Permissions";
import { useLocalRunner } from "../lib/localRunner";
import { ComposerAgent } from "./Connections";
import { useAutoSizeTextarea } from "../lib/autoSizeTextarea";

/** An agent's message: revealed smoothly while its turn is live, with a cursor at the end. */
function StreamText({ text, live, handles, logins }: { text: string; live: boolean; handles: Set<string>; logins: Set<string> }) {
  const shown = useSmoothText(text, live);
  if (!shown && !live) return null;
  return <div className="tx"><Markdown text={shown} handles={handles} people={logins} live={live} /></div>;
}

type Detail = { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] };
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const QUICK = ["👍", "🔥", "👀", "✅"];
const MORE = ["👍", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😂", "🙏", "👎"];

export function ChatView({ me, chat, detail, logins, setModal }: { me: Me; chat: Doc<"chats">; detail: Detail; logins: Set<string>; setModal: (m: ModalKind) => void }) {
  const localRunnerId = useLocalRunner();
  const typing = useTyping(chat._id);
  const attachments = useAttachments(chat._id);
  const fileDrop = useFileDrop(attachments.add);
  const [sending, setSending] = useState(false);
  const preferences = useQuery(api.users.preferences) ?? [];
  const messages = useQuery(api.messages.list, { chatId: chat._id });
  const people = useQuery(api.users.byLogins, { logins: Array.from(logins) });
  const send = useMutation(api.messages.send);
  const react = useMutation(api.messages.react);
  const setRepo = useMutation(api.chats.setRepo);
  const share = useMutation(api.chats.share);
  const setMembers = useMutation(api.chats.setMembers);
  const setAgents = useMutation(api.chats.setAgents);
  const invite = useMutation(api.workspaces.invite);
  const stopRun = useMutation(api.runs.interrupt);
  const abandonRun = useMutation(api.runs.abandon);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 2000); return () => clearInterval(t); }, []);
  const runs = useQuery(api.runs.forChat, { chatId: chat._id });
  const runEvents = useQuery(api.runs.eventsForChat, { chatId: chat._id });
  const scroll = useFollowScroll(chat._id, messages !== undefined && runs !== undefined && runEvents !== undefined);
  const changes = useQuery(api.changes.forChat, { chatId: chat._id }) ?? [];
  const setState = useMutation(api.chats.setState);
  const removeRepo = useMutation(api.chats.removeRepo);
  const repos = chat.repos ?? (chat.repo ? [chat.repo] : []);
  const threadState = chat.state ?? "open";
  const openChangeFor = (repo: string) => changes.find((c) => c.repo === repo && c.state === "open") ?? null;
  const lastChangeFor = (repo: string) => [...changes].filter((c) => c.repo === repo).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  const u = useUi();
  const [highlightedMessage, setHighlightedMessage] = useState<{ id: string; key: number } | null>(null);
  useEffect(() => {
    if (!highlightedMessage) return;
    const timer = window.setTimeout(() => setHighlightedMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessage]);
  useEffect(() => {
    const target = u.messageTarget;
    if (!target || target.chatId !== chat._id || !messages || !runs || !runEvents) return;
    const el = scroll.content.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(target.messageId)}"]`);
    if (!el) { toast("That message is no longer available."); ui.clearMessageTarget(); return; }
    scroll.pause.current();
    el.scrollIntoView({ block: "center", behavior: "instant" });
    setHighlightedMessage({ id: target.messageId, key: target.key }); el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true });
    ui.clearMessageTarget();
  }, [u.messageTarget, chat._id, messages, runs, runEvents]);
  const views = useMemo(() => {
    const out: Record<string, RunView> = {};
    for (const [id, evs] of Object.entries(runEvents ?? {})) out[id] = fold(id, evs as never);
    return out;
  }, [runEvents]);
  const liveRuns = runs?.filter(r => isLive(r.state)) ?? [];
  const [steerRunId, setSteerRunId] = useState<Id<"runs"> | null>(null);

  const [text, setText] = useState("");
  const [pop, setPop] = useState<{ q: string; sel: number } | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const inputRef = useAutoSizeTextarea(text);

  const handles = useMemo(() => new Set(detail.agents.map((a) => a.handle)), [detail.agents]);
  const chatAgents = chat.agents ? detail.agents.filter((a) => chat.agents!.includes(a._id)) : detail.agents;
  const pinned = chat.pinnedAgent ? detail.agents.find((a) => a._id === chat.pinnedAgent) ?? null : null;
  const mentionedAgent = firstMention(text, handles);
  const permissionAgent = mentionedAgent ? chatAgents.find(a => a.handle === mentionedAgent) : chat.private ? pinned : null;
  const members = chat.private ? [me.githubLogin] : chat.members;
  const liveRun = steerRunId ? liveRuns.find(r => r._id === steerRunId) ?? null : liveRuns.find(r => r.dispatchedBy === me.githubLogin && r.agentId === permissionAgent?._id) ?? null;
  const liveAgent = liveRun ? detail.agents.find(a => a._id === liveRun.agentId) ?? null : null;
  const composerAgent = liveAgent ?? permissionAgent;
  useEffect(() => { if (steerRunId && runs && !runs.some(r => r._id === steerRunId && isLive(r.state))) setSteerRunId(null); }, [runs, steerRunId]);
  const connectionPreview = useQuery(api.connections.preview, composerAgent && !liveRun ? { chatId: chat._id, harness: composerAgent.harness, ...(localRunnerId ? { localRunnerId } : {}) } : "skip");

  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [chat._id]);
  useEffect(() => {
    const close = () => { setRepoOpen(false); setScopeOpen(false); setMore(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const nameOf = (login: string) => (login === me.githubLogin ? me.name : people?.[login]?.name ?? login);
  const agentOf = (author: string) => detail.agents.find((a) => `agent:${a._id}` === author) ?? null;

  const mentionNames = new Set([...logins].flatMap(login => [login.toLowerCase(), nameOf(login).toLowerCase()]));
  const attribution = (run: Doc<"runs"> | undefined) => run?.execution ? <RunAttribution run={run} nameOf={nameOf} /> : null;

  type PopItem = { v: string; label: string; d: string; kind: "agent" | "person"; harness?: string };
  const popItems = useMemo((): PopItem[] => {
    if (!pop) return [];
    const q = pop.q.toLowerCase();
    const ag = chatAgents.filter((a) => !q || a.handle.startsWith(q) || (HARNESS_NAME[a.harness] ?? "").toLowerCase().startsWith(q)).map((a): PopItem => ({ v: a.handle, label: HARNESS_NAME[a.harness] ?? a.harness, d: `${preferences.find((p) => p.harness === a.harness)?.model ?? a.model} · ${preferences.find((p) => p.harness === a.harness)?.effort ?? a.effort}`, kind: "agent", harness: a.harness }));
    const pp = (chat.private ? chat.members : [...logins]).filter((m) => m !== me.githubLogin && (!q || m.toLowerCase().startsWith(q) || nameOf(m).toLowerCase().includes(q))).map((m): PopItem => ({ v: m, label: nameOf(m), d: "member", kind: "person" }));
    return [...ag, ...pp];
  }, [pop, chatAgents, chat.private, chat.members, logins, me.githubLogin, people, preferences]);

  function updatePop(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([a-z0-9-]*)$/i);
    setPop(m ? { q: m[1] ?? "", sel: 0 } : null);
  }
  function pick(v: string) {
    const item = popItems.find(p => p.v === v);
    const handle = item?.kind === "person" ? item.label : v;
    const el = inputRef.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@[a-z0-9-]*$/i, `@${handle} `);
    const next = before + text.slice(caret);
    setText(next); setPop(null);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; });
  }

  async function submit() {
    const body = text.trim();
    if ((!body && !attachments.drafts.length) || attachments.busy || sending) return;
    if (composerAgent && !liveRun && !connectionPreview?.selected) { toast(connectionPreview?.error ?? "Checking account connection…"); return; }
    setSending(true);
    const mention = firstMention(body, handles);
    typing.stop();
    setText(""); setPop(null);
    const followSentMessage = scroll.resume.current;
    try {
      const r = await send({ chatId: chat._id, text: body, mentionHandle: mention, ...(liveRun ? { targetRunId: liveRun._id } : {}), ...(localRunnerId ? { localRunnerId } : {}), ...(connectionPreview?.selected ? { expectedConnection: connectionPreview.selected.key } : {}), attachments: attachments.drafts.map(f=>f.id) });
      followSentMessage();
      attachments.clear();
      if (r.kind !== "text") toast(r.kind === "steer" ? "Steer queued for the next turn" : `Dispatched to ${r.runner ?? "your runner"}`);
    } catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); setText(body); } finally { setSending(false); }
  }

  const rows = useMemo(() => timeline(messages ?? [], runs ?? [], views), [messages, runs, views]);

  return (
    <main className="thread" inert={!!(u.panels[chat._id]?.open && u.panels[chat._id]?.maximized)} aria-hidden={!!(u.panels[chat._id]?.open && u.panels[chat._id]?.maximized)} {...fileDrop.handlers}>
      {fileDrop.dragging && <div className="file-drop-overlay" role="status"><div><span className="file-drop-icon" aria-hidden="true">↓</span><strong>Drop to attach</strong><span>Files will be added to your message</span></div></div>}
      <div className="thead">
        {chat.private && <span className="lk" title="Private · only you">{ICO.lock}</span>}
        <span className={`t${chat.untitled ? " untitled" : ""}`}>{chat.title}</span>
        <span className={`sel repopick${repoOpen ? " open" : ""}`} tabIndex={0} onClick={(e) => { e.stopPropagation(); setRepoOpen(!repoOpen); }}>
          <span className="chip addrepo" title="Add a repo to this thread">{repos.length ? "+" : "+ repo"}</span>
          <span className="dd">
            <span className="ddh">Add a repo from {detail.name}</span>
            {detail.repos.filter((r) => !repos.includes(r)).map((r) => <button key={r} onClick={(e) => { e.stopPropagation(); setRepoOpen(false); setRepo({ chatId: chat._id, repo: r }).then(() => toast(`${r} added · checked out in the thread on the next run`), (err) => toast(String((err as Error).message).replace(/^.*Uncaught Error: /, ""))); }}>{r}</button>)}
            <button onClick={(e) => { e.stopPropagation(); setRepoOpen(false); setModal({ kind: "addrepo" }); }}>+ connect another repo</button>
          </span>
        </span>
        {repos.map((r) => {
          const c = openChangeFor(r) ?? lastChangeFor(r);
          const href = c?.prUrl ?? null;
          const stateLabel = !c ? "no change yet" : c.state === "open" ? (c.prNumber ? `#${c.prNumber} open` : "branch pushed") : c.prNumber ? `#${c.prNumber} ${c.state}` : c.state;
          return <span key={r} className={`chip change ${c?.state ?? "none"}`} title={c ? `${c.branch} · +${c.add} −${c.del} · ${c.files} files${href ? " · open PR" : ""}` : `${r} · a branch and PR appear when an agent lands work here`}
            onClick={(e) => { e.stopPropagation(); if (href) { const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam; if (b?.openExternal) b.openExternal(href); else window.open(href, "_blank", "noopener"); } }}>
            <i>{r.split("/")[1]}</i>{stateLabel}
            <button className="rm" title={`Remove ${r} from this thread`} aria-label={`Remove ${r} from this thread`} onClick={(e) => { e.stopPropagation(); removeRepo({ chatId: chat._id, repo: r }).then(() => toast(`${r} removed from the thread`), (err) => toast(String((err as Error).message).replace(/^.*Uncaught Error: /, ""))); }}>×</button></span>;
        })}
        <span className="sp" />
        <StudyContext key={chat._id} chatId={chat._id} onDescribe={()=>{setText(t=>t||"Create a simulation study for ");inputRef.current?.focus();}}/>
        <button className="context-toggle" onClick={()=>ui.openContext(chat._id)} title="Files, links, and sources for this chat">Context</button>
        {threadState === "open"
          ? <button className="donebtn" title="Settle this thread when you are done with it. A new message reopens it." onClick={() => void setState({ chatId: chat._id, state: "settled" }).then(() => toast("Settled · a new message reopens it"))}>settle</button>
          : <button className="donebtn settled" title="Reopen this thread" onClick={() => void setState({ chatId: chat._id, state: "open" }).then(() => toast("Reopened"))}>settled{changes.some((c) => c.state === "open") ? ` · ${changes.filter((c) => c.state === "open").length} PR${changes.filter((c) => c.state === "open").length === 1 ? "" : "s"} open` : ""}</button>}
        <div className="scope" onClick={(e) => e.stopPropagation()}>
          <button className="scopebtn" onClick={() => setScopeOpen(!scopeOpen)} title={chat.private ? "Private · just you" : "Members and agents"}>
            {chat.private && <span className="k">private</span>}
            <span className="pres">{members.map((l) => <PersonAvatar key={l} login={l} name={nameOf(l)} image={people?.[l]?.image ?? null} hue={l === me.githubLogin ? "me" : hueClass(l)} />)}</span>
            <span className="sep" />
            <span className="pres">{chatAgents.map((a) => <AgentAvatar key={a._id} harness={a.harness} />)}</span>
            <span className="k">+</span>
          </button>
          <div className="scopepop" hidden={!scopeOpen}>
            <div className="sph">{chat.private ? <>{ICO.lock}<span>Private · just you</span></> : <>{ICO.team}<span>Who is in this chat</span></>}</div>
            <div className="sps">People</div>
            {detail.members.map((l) => {
              const on = members.includes(l);
              return <button key={l} className={`spo${on ? " on" : ""}`} disabled={l === me.githubLogin} onClick={() => {
                if (chat.private) { setShareWith([l]); setShareOpen(true); return; }
                const next = on ? members.filter((x) => x !== l) : [...members, l];
                if (!next.length) { toast("A chat needs at least one member"); return; }
                void setMembers({ chatId: chat._id, members: next }); toast(on ? `${nameOf(l)} removed from this chat` : `${nameOf(l)} added · they see the whole history`);
              }}><PersonAvatar login={l} name={nameOf(l)} image={people?.[l]?.image ?? null} hue={l === me.githubLogin ? "me" : hueClass(l)} /><span>{nameOf(l)}{l === me.githubLogin && <> <span className="k">you</span></>}</span><span className="chk">{on ? "✓" : ""}</span></button>;
            })}
            <button className="spo add" onClick={() => { setScopeOpen(false); setModal({ kind: "invite" }); }}><span className="av plus">+</span><span>Invite someone new</span></button>
            <div className="sps">Agents</div>
            {detail.agents.map((a) => {
              const on = chatAgents.some((x) => x._id === a._id);
              return <button key={a._id} className={`spo${on ? " on" : ""}`} onClick={() => { const cur = chatAgents.map((x) => x._id); const next = on ? cur.filter((x) => x !== a._id) : [...cur, a._id]; void setAgents({ chatId: chat._id, agents: next.length === detail.agents.length ? null : next }); }}><AgentAvatar harness={a.harness} /><span>{HARNESS_NAME[a.harness]} <span className="k">@{a.handle}</span></span><span className="chk">{on ? "✓" : ""}</span></button>;
            })}
            <div className="spf">{chat.private ? "Adding a person shares the whole history. That cannot be undone." : "Unchecked agents cannot be @mentioned here."}</div>
          </div>
        </div>
      </div>

      <div className="msgs" ref={scroll.viewport} tabIndex={0} aria-label="Chat messages">
        <div className="msgs-content" ref={scroll.content}>
        {messages && messages.length > 0 && <div className="daysep"><span>Started {dayLabel(chat._creationTime)} · {hhmm(chat._creationTime)}{chat.private ? " · private" : ""}</span></div>}
        {messages && messages.length === 0 && (chat.private
          ? <div className="empty"><b>Just you{pinned ? ` and ${HARNESS_NAME[pinned.harness]}` : ""}.</b><span>Your first message names the chat. {pinned ? "Plain messages go straight to the pinned agent." : "@mention an agent when you want one."} Share it from the header whenever it turns into something.</span></div>
          : <div className="empty"><b>Just you for now.</b><span>Invite people from the header and they join this chat. {repos.length ? `Working in ${repos.join(", ")}; branches and PRs appear as agents land work.` : "No repo yet: talk, investigate, or ask an agent to attach one or pick up a PR."} Your first message names the chat.</span></div>)}
        {rows.map((row) => {
          const ag = agentOf(row.author);
          if (row.kind !== "message") {
            const run = row.run, view = views[run._id] ?? null;
            const name = `${nameOf(run.dispatchedBy)}’s ${ag ? HARNESS_NAME[ag.harness]! : "Agent"}`;
            const current = view?.turns.at(-1);
            const activeTable = rows.some((r) => r.kind === "activity" && r.run._id === run._id && r.live);
            return <div key={row.key} className={`msg report${row.cont ? " cont" : ""}`}>
              <AgentAvatar harness={ag?.harness ?? "claude"} />
              <div>
                <div className="hd"><span className={`nm ${ag?.harness ?? "claude"}`}>{name}</span>{attribution(run)}<span className="tm">{hhmm(row.at)}</span></div>
                {row.kind === "activity" && <Activity t={row.turn} live={row.live} agentName={name} lastAt={view?.lastAt ?? null} queued={row.live ? view?.queuedSteers ?? 0 : 0} note={row.live ? view?.note ?? null : null} />}
                {row.kind === "status" && <>
                  <RunStatus run={run} view={view} />
                  {current && !activeTable && !current.done && <Activity t={{ ...current, activity: [] }} live agentName={name} lastAt={view?.lastAt ?? null} queued={view?.queuedSteers ?? 0} note={view?.note ?? null} />}
                  {view && [...new Set(view.requests.map((r) => r.turn))].map((turn) => <Requests key={turn} view={view} turn={turn} runId={run._id} />)}
                </>}
                {row.kind === "landing" && <><RunStatus run={run} view={view} /><LandingCard run={run} /></>}
              </div>
            </div>;
          }
          const m = row.message;
          const mine = m.author === me.githubLogin;
          return (
            <div key={m._id} data-mid={m._id} className={`msg${highlightedMessage?.id === m._id ? " notification-target" : ""}${row.cont ? " cont" : ""}${m.kind === "dispatch" || m.kind === "steer" || m.kind === "report" ? ` ${m.kind}` : ""}`}>
              {ag ? <AgentAvatar harness={ag.harness} /> : <PersonAvatar login={m.author} name={nameOf(m.author)} image={people?.[m.author]?.image ?? null} hue={mine ? "me" : hueClass(m.author)} />}
              <div>
                <div className="hd"><span className={`nm ${ag ? (ag.harness === "codex" ? "codex" : ag.harness === "omp" ? "omp" : "claude") : mine ? "me" : hueClass(m.author)}`}>{ag ? `${nameOf(runs?.find(r => r._id === m.runId)?.dispatchedBy ?? "Unknown")}’s ${HARNESS_NAME[ag.harness]}` : nameOf(m.author)}</span>{ag && attribution(runs?.find((r) => r._id === m.runId))}<span className="tm">{hhmm(row.at)}</span></div>
                {m.studyContext&&<div className="study-message-context">{m.studyContext.name} · r{m.studyContext.revision}</div>}
                {!m.simulationStudyId && (m.kind === "report" ? <StreamText text={m.text} live={row.live} handles={handles} logins={mentionNames} /> : m.text && <div className="tx"><Markdown text={m.text} handles={handles} people={mentionNames} /></div>)}
                {m.attachments?.length ? <MessageFiles ids={m.attachments} chatId={chat._id} /> : null}
                {m.simulationStudyId && <StudyCard id={m.simulationStudyId} chatId={chat._id} />}
                {m.computeJobId && <JobCard id={m.computeJobId} chatId={chat._id} />}
                {m.routed?.error && <div className="rcpt" role="status">{m.routed.error} <button className="btn ghost" onClick={() => setModal({ kind: "settings", tab: "machines" })}>Settings</button></div>}
                {m.routed?.agent && (() => { const ra = detail.agents.find((a) => a.handle === m.routed!.agent); return <div className="rcpt" title={m.routed.why}><i>→</i> {ra ? HARNESS_NAME[ra.harness] : `@${m.routed.agent}`} · {m.kind === "steer" ? "steered" : "picked this up"}</div>; })()}
                {m.reactions.length > 0 && <div className="reacts">{m.reactions.map((r) => <button key={r.emoji} className={`rc${r.by.includes(me.githubLogin) ? " mine" : ""}`} title={r.by.map(nameOf).join(", ")} onClick={() => void react({ messageId: m._id, emoji: r.emoji })}>{r.emoji} <span>{r.by.length}</span></button>)}</div>}
                <div className={`rbar${more === m._id ? " open" : ""}`} onClick={(e) => e.stopPropagation()}>
                  {(more === m._id ? MORE : QUICK).map((e) => <button key={e} onClick={() => { void react({ messageId: m._id, emoji: e }); setMore(null); }}>{e}</button>)}
                  {more !== m._id && <button onClick={() => setMore(m._id)} title="More">+</button>}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      </div>

      <TypingIndicator chatId={chat._id} me={me.githubLogin} nameOf={nameOf} />
      <div className="composer">
        {liveRuns.length > 0 && <div className="active-agents" aria-label="Active agents">{liveRuns.map(run => {
          const agent = detail.agents.find(a => a._id === run.agentId);
          const label = `${nameOf(run.dispatchedBy)}’s ${agent ? HARNESS_NAME[agent.harness] : "agent"}`;
          return <div className="active-agent" key={run._id}><span className="sq run" /><span>{label} · {run.execution?.machineName ?? run.runnerName}</span><button className="ctl" aria-pressed={steerRunId === run._id} onClick={() => { setSteerRunId(steerRunId === run._id ? null : run._id); inputRef.current?.focus(); }}>{steerRunId === run._id ? "Cancel reply" : "Reply"}</button>{!run.interruptRequestedAt ? <button className="stopbtn" aria-label={`Stop ${label}`} onClick={() => void stopRun({ runId: run._id }).catch(e => toast(e.message))}>■ Stop</button> : tick - run.interruptRequestedAt > 15_000 ? <button className="stopbtn force" onClick={() => void abandonRun({ runId: run._id })}>Force stop</button> : <span className="hint">Stopping…</span>}</div>;
        })}</div>}
        {attachments.chips}
        {liveRun?.execution && <div className="composer-model">{nameOf(liveRun.execution.accountOwner)}’s {liveAgent ? HARNESS_NAME[liveAgent.harness] : "agent"} · {liveRun.execution.connectionName ?? liveRun.execution.accountEmail ?? "Account not reported"} · {liveRun.execution.machineName ?? liveRun.runnerName}{(liveRun.execution.modelName ?? liveRun.execution.model) ? ` · ${liveRun.execution.modelName ?? liveRun.execution.model}${liveRun.execution.effort ? ` · ${liveRun.execution.effort}` : ""}` : ""} · continuing current run</div>}
        {pop && popItems.length > 0 && (
          <div className="popover">
            {popItems.some((x) => x.kind === "agent") && <div className="ph">Agents</div>}
            {popItems.filter((x) => x.kind === "agent").map((x, i) => <button key={x.v} className={`po${pop.sel === i ? " sel" : ""}`} onClick={() => pick(x.v)}><AgentAvatar harness={x.harness ?? "claude"} /><span>{x.label} <span className="k">@{x.v}</span></span><span className="d">{x.d}</span></button>)}
            {popItems.some((x) => x.kind === "person") && <div className="ph">People</div>}
            {popItems.filter((x) => x.kind === "person").map((x) => { const i = popItems.indexOf(x); return <button key={x.v} className={`po${pop.sel === i ? " sel" : ""}`} onClick={() => pick(x.v)}><PersonAvatar login={x.v} name={x.label} image={people?.[x.v]?.image ?? null} hue={hueClass(x.v)} /><span>{x.label}</span><span className="d">{x.d}</span></button>; })}
          </div>
        )}
        <textarea ref={inputRef} rows={1} value={text} placeholder={chat.private && pinned ? `Message ${HARNESS_NAME[pinned.harness]}, or @mention another agent` : `Message ${chat.title}, or @mention an agent`}
          onBlur={typing.stop}
          onPaste={e=>void attachments.paste(e, pasted=>{const el=inputRef.current!;const start=el.selectionStart;const next=text.slice(0,start)+pasted+text.slice(el.selectionEnd);setText(next);typing.change(next);requestAnimationFrame(()=>{el.selectionStart=el.selectionEnd=start+pasted.length;});})}
          onChange={(e) => { typing.change(e.target.value); setText(e.target.value); updatePop(e.target.value, e.target.selectionStart); }}
          onKeyDown={(e) => {
            if (pop && popItems.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pick(popItems[pop.sel]!.v); return; }
            if (pop && popItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPop({ ...pop, sel: (pop.sel + (e.key === "ArrowDown" ? 1 : -1) + popItems.length) % popItems.length }); return; }
            if (e.key === "Escape") { setPop(null); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          }} />
        <div className="ft">
          <div className="composer-tools">
            <ComposerPermissions agents={permissionAgent ? [permissionAgent] : chatAgents} />
            {composerAgent && !liveRun && (() => { const p = preferences.find((p) => p.harness === composerAgent.harness); return <ComposerAgent chatId={chat._id} agent={composerAgent} model={p?.model ?? composerAgent.model} effort={p?.effort ?? composerAgent.effort} preview={connectionPreview} onOpenDefaults={() => setModal({ kind: "settings", tab: "models" })} />; })()}
            {attachments.controls}
            <button onClick={() => { const el = inputRef.current!; const v = text + (text && !/\s$/.test(text) ? " " : "") + "@"; setText(v); el.focus(); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = v.length; updatePop(v, v.length); }); }} className="tool-chip" title="Mention an agent or person"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8"/></svg>Mention</button>

          </div>
          <button className="sendbtn" type="button" aria-label={sending ? "Sending message" : "Send message"} title={sending ? "Sending…" : "Send message (Enter)"} disabled={sending || attachments.busy || (!text.trim() && !attachments.drafts.length)} onClick={() => { void submit(); inputRef.current?.focus({ preventScroll: true }); }}>
            {ICO.arrowUp}
          </button>
        </div>
      </div>

      <Modal open={shareOpen} onClose={() => setShareOpen(false)}>
        <div className="m-h">{ICO.team} Share this chat</div>
        <div className="row"><span>With</span><Seg value={shareWith.length === 0 ? "ws" : shareWith[0]!} options={[["ws", `everyone in ${detail.name}`] as const, ...detail.members.filter((m) => m !== me.githubLogin).map((m) => [m, nameOf(m)] as const)]} onChange={(v) => setShareWith(v === "ws" ? [] : [v])} /></div>
        <div className="row"><span>History</span><span className="hint">all {messages?.length ?? 0} messages become visible from the first one. This cannot be undone.</span></div>
        {pinned && <div className="row"><span>Default agent</span><span className="hint">unpinned on share · team chats dispatch by @mention only</span></div>}
        <div className="m-f"><span>Shared chats never go private again.</span><span><button className="btn ghost" onClick={() => setShareOpen(false)}>Cancel</button> <button className="btn" onClick={async () => { await share({ chatId: chat._id, members: shareWith.length ? shareWith : detail.members }); setShareOpen(false); toast("Shared · everyone can see it now"); }}>Share</button></span></div>
      </Modal>
      <span hidden>{u.prefs.addToChat}{String(invite)}</span>
    </main>
  );
}
