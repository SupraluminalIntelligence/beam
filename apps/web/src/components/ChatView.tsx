import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { dayLabel, firstMention, hhmm, hueClass, renderText } from "../lib/format";
import { useUi } from "../lib/ui";
import { useSmoothText } from "../lib/smooth";
import { AgentAvatar, ICO, PersonAvatar } from "./Avatar";
import { Modal, Seg } from "./Modal";
import { fold, type RunView } from "@beam/reducer";
import { Activity, LandingCard, Requests, RunStatus, isLive } from "./RunBlocks";
import type { Me, ModalKind } from "./Shell";
import { toast } from "./Toast";

/** An agent's message: revealed smoothly while its turn is live, with a cursor at the end. */
function StreamText({ text, live, handles, logins }: { text: string; live: boolean; handles: Set<string>; logins: Set<string> }) {
  const shown = useSmoothText(text, live);
  if (!shown && !live) return null;
  return <div className="tx pre">{renderText(shown, handles, logins)}{live && <span className="cursor" />}</div>;
}

type Detail = { id: Id<"workspaces">; name: string; repos: string[]; members: string[]; agents: Doc<"agents">[] };
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const QUICK = ["👍", "🔥", "👀", "✅"];
const MORE = ["👍", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😂", "🙏", "👎"];

export function ChatView({ me, chat, detail, logins, setModal }: { me: Me; chat: Doc<"chats">; detail: Detail; logins: Set<string>; setModal: (m: ModalKind) => void }) {
  const messages = useQuery(api.messages.list, { chatId: chat._id });
  const people = useQuery(api.users.byLogins, { logins: Array.from(logins) });
  const send = useMutation(api.messages.send);
  const react = useMutation(api.messages.react);
  const setRepo = useMutation(api.chats.setRepo);
  const share = useMutation(api.chats.share);
  const setMembers = useMutation(api.chats.setMembers);
  const setAgents = useMutation(api.chats.setAgents);
  const pinAgent = useMutation(api.chats.pinAgent);
  const invite = useMutation(api.workspaces.invite);
  const stopRun = useMutation(api.runs.interrupt);
  const setAutoRoute = useMutation(api.chats.setAutoRoute);
  const runs = useQuery(api.runs.forChat, { chatId: chat._id });
  const runEvents = useQuery(api.runs.eventsForChat, { chatId: chat._id });
  const u = useUi();
  const views = useMemo(() => {
    const out: Record<string, RunView> = {};
    for (const [id, evs] of Object.entries(runEvents ?? {})) out[id] = fold(id, evs as never);
    return out;
  }, [runEvents]);
  const liveRun = runs?.find((r) => isLive(r.state)) ?? null;
  const liveAgent = liveRun ? detail.agents.find((a) => a._id === liveRun.agentId) ?? null : null;

  const [text, setText] = useState("");
  const [pop, setPop] = useState<{ q: string; sel: number } | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);

  const handles = useMemo(() => new Set(detail.agents.map((a) => a.handle)), [detail.agents]);
  const chatAgents = chat.agents ? detail.agents.filter((a) => chat.agents!.includes(a._id)) : detail.agents;
  const pinned = chat.pinnedAgent ? detail.agents.find((a) => a._id === chat.pinnedAgent) ?? null : null;
  const members = chat.private ? [me.githubLogin] : chat.members;

  const tailText = messages?.length ? messages[messages.length - 1]!.text.length : 0;
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages?.length, tailText, runEvents]);
  useEffect(() => { inputRef.current?.focus(); }, [chat._id]);
  useEffect(() => {
    const close = () => { setRepoOpen(false); setScopeOpen(false); setPinOpen(false); setMore(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const nameOf = (login: string) => (login === me.githubLogin ? me.name : people?.[login]?.name ?? login);
  const isAgent = (author: string) => author.startsWith("agent:");
  const agentOf = (author: string) => detail.agents.find((a) => `agent:${a._id}` === author) ?? null;

  type PopItem = { v: string; label: string; d: string; kind: "agent" | "person"; harness?: string };
  const popItems = useMemo((): PopItem[] => {
    if (!pop) return [];
    const q = pop.q.toLowerCase();
    const ag = chatAgents.filter((a) => !q || a.handle.startsWith(q) || (HARNESS_NAME[a.harness] ?? "").toLowerCase().startsWith(q)).map((a): PopItem => ({ v: a.handle, label: HARNESS_NAME[a.harness] ?? a.harness, d: `${a.model} · ${a.effort}`, kind: "agent", harness: a.harness }));
    const pp = members.filter((m) => m !== me.githubLogin && (!q || m.startsWith(q))).map((m): PopItem => ({ v: m, label: nameOf(m), d: "member", kind: "person" }));
    return [...ag, ...pp];
  }, [pop, chatAgents, members, me.githubLogin, people]);

  function updatePop(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([a-z0-9-]*)$/i);
    setPop(m ? { q: m[1] ?? "", sel: 0 } : null);
  }
  function pick(v: string) {
    const el = inputRef.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@[a-z0-9-]*$/i, `@${v} `);
    const next = before + text.slice(caret);
    setText(next); setPop(null);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; });
  }

  async function submit() {
    const body = text.trim();
    if (!body) return;
    const mention = firstMention(body, handles);
    setText(""); setPop(null);
    try {
      const r = await send({ chatId: chat._id, text: body, mentionHandle: mention });
      if (r.kind !== "text") toast(r.kind === "steer" ? "Steer queued for the next turn" : `Dispatched to ${r.runner ?? "your runner"}`);
    } catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); setText(body); }
  }

  const grouped = useMemo(() => {
    let prev: string | null = null;
    const lastReport: Record<string, string> = {};
    for (const m of messages ?? []) if (m.kind === "report" && m.runId) lastReport[m.runId] = m._id;
    return (messages ?? []).map((m) => { const cont = m.author === prev; prev = m.author; return { m, cont, lastOfRun: !!m.runId && lastReport[m.runId] === m._id }; });
  }, [messages]);
  // Runs whose current turn has no text yet get a trailing block of their own.
  const trailing = useMemo(() => {
    const spoken = new Set((messages ?? []).filter((m) => m.kind === "report").map((m) => `${m.runId}:${m.turn}`));
    return (runs ?? []).filter((r) => {
      const v = views[r._id];
      const turn = v?.turns.length ?? 0;
      if (isLive(r.state)) return !spoken.has(`${r._id}:${turn}`);
      return turn === 0 || (!spoken.has(`${r._id}:${turn}`) && (r.landing || r.state === "failed"));
    }).map((r) => ({ r, v: views[r._id] ?? null }));
  }, [runs, views, messages]);
  const lastAuthor = messages?.length ? messages[messages.length - 1]!.author : null;

  return (
    <main className="thread">
      <div className="thead">
        {chat.private && <span className="lk" title="Private · only you">{ICO.lock}</span>}
        <span className={`t${chat.untitled ? " untitled" : ""}`}>{chat.title}</span>
        <span className={`sel repopick${repoOpen ? " open" : ""}`} tabIndex={0} onClick={(e) => { e.stopPropagation(); setRepoOpen(!repoOpen); }}>
          {chat.repo ? <span className="chip">{chat.repo}</span> : <span className="chip addrepo">+ repo</span>}
          <span className="dd">
            <span className="ddh">Repos in {detail.name}</span>
            {detail.repos.map((r) => <button key={r} className={r === chat.repo ? "on" : ""} onClick={(e) => { e.stopPropagation(); setRepoOpen(false); setRepo({ chatId: chat._id, repo: r }).then(() => toast(`${r} attached · worktree on first dispatch`), (err) => toast(String((err as Error).message).replace(/^.*Uncaught Error: /, ""))); }}>{r}</button>)}
            <button onClick={(e) => { e.stopPropagation(); setRepoOpen(false); setModal({ kind: "addrepo" }); }}>+ connect another repo</button>
            {chat.repo && !chat.activeBranch && <span className="ddf">Worktree and branch are created automatically on the first dispatch.</span>}
          </span>
        </span>
        {chat.activeBranch && <span className="chip">{chat.activeBranch}</span>}
        <span className="sp" />
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

      <div className="msgs" ref={msgsRef}>
        {messages && messages.length > 0 && <div className="daysep"><span>Started {dayLabel(chat._creationTime)} · {hhmm(chat._creationTime)}{chat.private ? " · private" : ""}</span></div>}
        {messages && messages.length === 0 && (chat.private
          ? <div className="empty"><b>Just you{pinned ? ` and ${HARNESS_NAME[pinned.harness]}` : ""}.</b><span>Your first message names the chat. {pinned ? "Plain messages go straight to the pinned agent." : "@mention an agent when you want one."} Share it from the header whenever it turns into something.</span></div>
          : <div className="empty"><b>Just you for now.</b><span>Invite people from the header and they join this chat. {chat.repo ? `Attached to ${chat.repo}; a worktree and branch appear on the first dispatch.` : "No repo yet: @mention an agent to talk, and it can attach one when the work has a home."} Your first message names the chat.</span></div>)}
        {grouped.map(({ m, cont, lastOfRun }) => {
          const ag = isAgent(m.author) ? agentOf(m.author) : null;
          const mine = m.author === me.githubLogin;
          const run = m.kind === "report" && m.runId ? runs?.find((r) => r._id === m.runId) ?? null : null;
          const view = run ? views[run._id] ?? null : null;
          const turnView = view && m.turn ? view.turns.find((t) => t.turn === m.turn) ?? null : null;
          const turnLive = !!run && isLive(run.state) && !!turnView && !turnView.done;
          return (
            <div key={m._id} className={`msg${cont ? " cont" : ""}${m.kind === "dispatch" || m.kind === "steer" || m.kind === "report" ? ` ${m.kind}` : ""}`}>
              {ag ? <AgentAvatar harness={ag.harness} /> : <PersonAvatar login={m.author} name={nameOf(m.author)} image={people?.[m.author]?.image ?? null} hue={mine ? "me" : hueClass(m.author)} />}
              <div>
                <div className="hd"><span className={`nm ${ag ? (ag.harness === "codex" ? "codex" : ag.harness === "omp" ? "omp" : "claude") : mine ? "me" : hueClass(m.author)}`}>{ag ? HARNESS_NAME[ag.harness] : nameOf(m.author)}</span><span className="tm">{hhmm(m._creationTime)}</span></div>
                {turnView && <Activity t={turnView} live={turnLive} agentName={ag ? HARNESS_NAME[ag.harness]! : "Agent"} />}
                {run && view && m.turn && <Requests view={view} turn={m.turn} runId={run._id} />}
                {m.kind === "report" ? <StreamText text={m.text} live={turnLive} handles={handles} logins={logins} /> : m.text && <div className="tx pre">{renderText(m.text, handles, logins)}</div>}
                {run && lastOfRun && !isLive(run.state) && !trailing.some((t) => t.r._id === run._id) && <LandingCard run={run} />}
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
        {trailing.map(({ r, v }) => {
          const ag = detail.agents.find((a) => a._id === r.agentId) ?? null;
          const name = ag ? HARNESS_NAME[ag.harness]! : "Agent";
          const t = v?.turns[v.turns.length - 1] ?? null;
          const live = isLive(r.state);
          return (
            <div key={r._id} className={`msg report${lastAuthor === `agent:${r.agentId}` ? " cont" : ""}`}>
              <AgentAvatar harness={ag?.harness ?? "claude"} />
              <div>
                <div className="hd"><span className={`nm ${ag?.harness === "codex" ? "codex" : ag?.harness === "omp" ? "omp" : "claude"}`}>{name}</span><span className="tm">{hhmm(r.startedAt ?? r._creationTime)}</span></div>
                <RunStatus run={r} view={v} />
                {t && <Activity t={t} live={live && !t.done} agentName={name} />}
                {v && t && <Requests view={v} turn={t.turn} runId={r._id} />}
                {!live && <LandingCard run={r} />}
              </div>
            </div>
          );
        })}
      </div>

      <div className="composer">
        {pop && popItems.length > 0 && (
          <div className="popover">
            {popItems.some((x) => x.kind === "agent") && <div className="ph">Agents</div>}
            {popItems.filter((x) => x.kind === "agent").map((x, i) => <button key={x.v} className={`po${pop.sel === i ? " sel" : ""}`} onClick={() => pick(x.v)}><AgentAvatar harness={x.harness ?? "claude"} /><span>{x.label} <span className="k">@{x.v}</span></span><span className="d">{x.d}</span></button>)}
            {popItems.some((x) => x.kind === "person") && <div className="ph">People</div>}
            {popItems.filter((x) => x.kind === "person").map((x) => { const i = popItems.indexOf(x); return <button key={x.v} className={`po${pop.sel === i ? " sel" : ""}`} onClick={() => pick(x.v)}><PersonAvatar login={x.v} name={x.label} image={people?.[x.v]?.image ?? null} hue={hueClass(x.v)} /><span>{x.label}</span><span className="d">{x.d}</span></button>; })}
          </div>
        )}
        <textarea ref={inputRef} rows={1} value={text} placeholder={chat.private && pinned ? `Message ${HARNESS_NAME[pinned.harness]}, or @mention another agent` : `Message ${chat.title}, or @mention an agent`}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; updatePop(e.target.value, e.target.selectionStart); }}
          onKeyDown={(e) => {
            if (pop && popItems.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pick(popItems[pop.sel]!.v); return; }
            if (pop && popItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPop({ ...pop, sel: (pop.sel + (e.key === "ArrowDown" ? 1 : -1) + popItems.length) % popItems.length }); return; }
            if (e.key === "Escape") { setPop(null); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); (e.target as HTMLTextAreaElement).style.height = "auto"; }
          }} />
        <div className="ft">
          <span>⏎ send</span>
          <button onClick={() => { const el = inputRef.current!; const v = text + (text && !/\s$/.test(text) ? " " : "") + "@"; setText(v); el.focus(); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = v.length; updatePop(v, v.length); }); }}>@ mention</button>
          <span className="sp" />
          {chat.private
            ? <span className={`sel pinsel${pinOpen ? " open" : ""}`} tabIndex={0} onClick={(e) => { e.stopPropagation(); setPinOpen(!pinOpen); }}>
                <span>{pinned ? `→ ${HARNESS_NAME[pinned.harness]} · plain messages dispatch` : "pin a default agent"}</span><i>▾</i>
                <span className="dd"><span className="ddh">Default agent</span>{detail.agents.map((a) => <button key={a._id} className={chat.pinnedAgent === a._id ? "on" : ""} onClick={(e) => { e.stopPropagation(); setPinOpen(false); void pinAgent({ chatId: chat._id, agentId: a._id }); }}>{HARNESS_NAME[a.harness]}</button>)}<button className={!chat.pinnedAgent ? "on" : ""} onClick={(e) => { e.stopPropagation(); setPinOpen(false); void pinAgent({ chatId: chat._id, agentId: null }); }}>none · @mention only</button></span>
              </span>
            : <span>{chat.activeBranch ? `chat → ${chat.activeBranch}` : chat.repo ? "no branch until first dispatch" : "no repo · talk freely, or ask the agent to attach one"}</span>}
          {!chat.private && <button className={`listen${(chat.autoRoute ?? true) ? " on" : ""}`} title="When on, agents read plain messages and act when one is for them. Mentions always work." onClick={() => { const on = !(chat.autoRoute ?? true); void setAutoRoute({ chatId: chat._id, on }); toast(on ? "Agents are listening · no need to @mention" : "Agents only act on @mentions now"); }}>agents {(chat.autoRoute ?? true) ? "listening" : "on mention only"}</button>}
          {liveRun && <button className="stopbtn" onClick={() => void stopRun({ runId: liveRun._id }).then(() => toast(`Stopping ${liveAgent ? HARNESS_NAME[liveAgent.harness] : "the run"} · branch will still be pushed`))}>■ stop {liveAgent ? HARNESS_NAME[liveAgent.harness] : "run"}</button>}
        </div>
      </div>

      <Modal open={shareOpen} onClose={() => setShareOpen(false)}>
        <div className="m-h">{ICO.team} Share this chat</div>
        <div className="row"><span>With</span><Seg value={shareWith.length === 0 ? "ws" : shareWith[0]!} options={[["ws", `everyone in ${detail.name}`] as const, ...detail.members.filter((m) => m !== me.githubLogin).map((m) => [m, nameOf(m)] as const)]} onChange={(v) => setShareWith(v === "ws" ? [] : [v])} /></div>
        <div className="row"><span>History</span><span className="hint">all {messages?.length ?? 0} messages become visible from the first one. This cannot be undone.</span></div>
        <div className="row"><span>Default agent</span><span className="hint">{pinned ? "unpinned on share · team chats dispatch by @mention only" : "none pinned"}</span></div>
        <div className="m-f"><span>Shared chats never go private again.</span><span><button className="btn ghost" onClick={() => setShareOpen(false)}>Cancel</button> <button className="btn" onClick={async () => { await share({ chatId: chat._id, members: shareWith.length ? shareWith : detail.members }); setShareOpen(false); toast("Shared · everyone can see it now"); }}>Share</button></span></div>
      </Modal>
      <span hidden>{u.prefs.addToChat}{String(invite)}</span>
    </main>
  );
}
