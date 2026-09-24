import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import type { ActivityLine, RunView, TurnView } from "@beam/reducer";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";
import { activityLabel, activitySummary } from "../lib/activity";

type Run = Doc<"runs"> & { runnerName: string };
export const isLive = (state: string) => state === "queued" || state === "starting" || state === "working" || state === "landing";

const ms = (n: number | null) => (n == null ? "" : n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`);
const span = (t: TurnView) => (t.startedAt && t.endedAt ? ms(t.endedAt - t.startedAt) : "");
/** A clock that ticks once a second while something is live, so elapsed times move. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  return now;
}
const QUIET_MS = 90_000;

const KIND_LABEL: Record<string, string> = { bash: "run", read: "read", edit: "edit", write: "write", search: "find", web: "web", agent: "agent", plan: "plan", ask: "ask", beam: "beam" };

/** One tool call: status square, kind, one clipped line, timing. Click for the full command and its output. */
function Step({ a, now }: { a: ActivityLine; now: number }) {
  const [open, setOpen] = useState(false);
  const running = a.ok === null && a.startedAt ? ms(Math.max(0, now - a.startedAt)) : null;
  const label = KIND_LABEL[a.kind] ?? a.kind.slice(0, 5);
  // "Read src/x.ts" → the file, since the kind column already says read
  const text = ["read", "edit", "write", "search", "web", "agent"].includes(a.kind) ? a.summary.replace(/^(Read|Edit|Write|Grep|Glob|List|Fetch|Search|Subagent · )\s*/, "") : activityLabel(a);
  return (
    <div className={`step${open ? " open" : ""}`}>
      <button className="stepline" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "collapse" : "show full command and output"}>
        <span className={`sq ${a.ok === null ? "run" : a.ok ? "ok" : "bad"}`} />
        <span className="kind">{label}</span>
        <span className="what">{text}</span>
        <span className={`r${running ? " live" : ""}`}>{running ?? ms(a.ms)}</span>
      </button>
      {open && <div className="stepdetail">
        {(a.kind === "bash" || activityLabel(a) !== a.summary) && <pre className="cmd">{a.summary}</pre>}
        <pre className="out">{a.detail ?? (a.ok === null ? "still running" : "no output")}</pre>
      </div>}
    </div>
  );
}

/** One turn's tool calls. Open while it runs, folded once it is done. */
export function Activity({ t, live, agentName, lastAt, queued = 0, note = null }: { t: TurnView; live: boolean; agentName: string; lastAt?: number | null; queued?: number; note?: string | null }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  const isOpen = open ?? live;
  if (!t.activity.length && !live) return null;
  const n = t.activity.length;
  const quiet = live && lastAt ? Math.max(0, now - lastAt) : 0;
  const elapsed = live && t.startedAt ? ms(Math.max(0, now - t.startedAt)) : "";
  const title = live ? (n ? `${agentName} is working · ${n} step${n === 1 ? "" : "s"}` : `${agentName} is thinking`) : `${n} step${n === 1 ? "" : "s"}`;
  const summary = activitySummary(t.activity);
  const failed = t.activity.filter((a) => a.ok === false).length;
  return (
    <div className={`act${isOpen ? "" : " closed"}${live && (note || quiet > QUIET_MS) ? " quiet" : ""}`}>
      <button className="ah" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} title={summary.full || title}>
        <span className="tog">{isOpen ? "▾" : "▸"}</span>
        <span className="activity-heading">
          {n > 0 && <span className="activity-summary">{summary.text}</span>}
          <span className="ttl">{title}{failed > 0 && <span className="activity-failed"> · {failed} failed</span>}</span>
        </span>
        {queued > 0 && <span className="chip" title={`${queued} message${queued === 1 ? "" : "s"} handed over; the agent reads them when this turn ends`}>{queued} queued</span>}
        <span className={`st ${live ? "work" : "done"}`}>
          {live && note && <span className="quietnote" title="What the harness reports it is waiting on">{note}</span>}
          {live && !note && quiet > QUIET_MS && <span className="quietnote" title="No report from the runner in a while: a long command, or something outside the chat. Stop is in the composer.">quiet {ms(quiet)}</span>}
          <i />{live ? elapsed : span(t)}
        </span>
      </button>
      <div className="stepwrap" inert={!isOpen} aria-hidden={!isOpen}><div className="steps">
        {t.activity.map((a) => <Step key={a.itemId} a={a} now={now} />)}
      </div></div>
    </div>
  );
}

const KEYS: Record<string, string> = { allow: "⌘⏎", always: "⌘⇧⏎", deny: "⌘⌫" };

function InputReply({ onReply }: { onReply: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  return <form className="inputreply" onSubmit={(e) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    void onReply(text.trim()).catch((err) => toast((err as Error).message)).finally(() => setSending(false));
  }}>
    <input aria-label="Reply to the agent" placeholder="Type an answer…" value={text} onChange={(e) => setText(e.target.value)} disabled={sending} />
    <button type="submit" disabled={!text.trim() || sending}>{sending ? "Sending…" : "Send"}</button>
  </form>;
}

/** A question the agent is waiting on. Anyone in the chat can answer; the first answer wins. ⌘⏎ allow · ⌘⇧⏎ always · ⌘⌫ deny. */
export function Requests({ view, turn, runId }: { view: RunView; turn: number; runId: Id<"runs"> }) {
  const respond = useMutation(api.runs.respond);
  const open = view.requests.filter((r) => r.turn === turn);
  const first = open[0] ?? null;
  useEffect(() => {
    if (!first || first.kind === "input") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const decision = e.key === "Enter" ? (e.shiftKey ? "always" : "allow") : e.key === "Backspace" ? "deny" : null;
      if (!decision || !(first.options ?? ["allow", "deny"]).includes(decision)) return;
      e.preventDefault(); e.stopPropagation();
      void respond({ runId, requestId: first.requestId, decision }).catch((err) => toast(String((err as Error).message)));
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [first?.requestId, runId]);
  if (!open.length) return null;
  return <>{open.map((r, i) => (
    <div key={r.requestId} className="ask">
      <div className="askp"><span className="k">{r.kind === "input" ? "waiting for an answer" : "waiting for approval"}</span><span style={{ whiteSpace: "pre-wrap" }}>{r.prompt}</span></div>
      <div className="perm">{(r.options ?? (r.kind === "input" ? [] : ["allow", "deny"])).map((o) => <button key={o} onClick={() => void respond({ runId, requestId: r.requestId, decision: o }).catch((e) => toast(String((e as Error).message)))}>{o}{r.kind === "approval" && i === 0 && KEYS[o] && <kbd>{KEYS[o]}</kbd>}</button>)}</div>
      {r.kind === "input" && <InputReply onReply={(decision) => respond({ runId, requestId: r.requestId, decision })} />}
    </div>
  ))}</>;
}

type Landing = { repos: { repo: string; branch: string; base: string; pushed: boolean; add: number; del: number; files: number; prUrl: string | null; compareUrl: string | null; error: string | null }[]; error: string | null };
const openHref = (href: string) => { const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam; if (b?.openExternal) b.openExternal(href); else window.open(href, "_blank", "noopener"); };

/** What a run left behind, one card per repo it changed. Nothing changed: no card. */
export function LandingCard({ run }: { run: Run }) {
  const raw = run.landing as null | Landing | { branch?: string };
  if (!raw) return run.state === "failed" ? <div className="ask fail"><div className="askp"><span className="k">run failed</span><span>See the log above. Nothing was pushed.</span></div></div> : null;
  const l: Landing = "repos" in raw ? raw : { repos: [], error: null }; // runs from before threads had one branch; they show nothing
  if (l.error) return <div className="ask fail"><div className="askp"><span className="k">{run.state === "interrupted" ? "run stopped" : "run failed"}</span><span>{l.error}</span></div></div>;
  if (!l.repos.length) return null;
  return <>{l.repos.map((r) => {
    const href = r.prUrl ?? r.compareUrl;
    return (
      <button key={r.repo} className="card" onClick={() => href && openHref(href)} title={href ?? undefined}>
        <span className="ai">⎇</span>
        <div>
          <div className="ttl">{r.branch}</div>
          <div className="mt">
            <span>{r.repo.split("/")[1]}</span>
            <span>{run.state === "interrupted" ? "stopped" : r.pushed ? "pushed" : "not pushed"}</span>
            {r.pushed && <><span className="add">+{r.add}</span><span className="del">−{r.del}</span><span>{r.files} file{r.files === 1 ? "" : "s"}</span></>}
            {r.error && <span className="err">{r.error}</span>}
            {href && <span className="hint">{r.prUrl ? "open PR" : "compare on GitHub"}</span>}
          </div>
        </div>
      </button>
    );
  })}</>;
}

/** The state line for a run that has not produced text yet. */
export function RunStatus({ run, view }: { run: Run; view: RunView | null }) {
  if (run.state === "queued") return <div className="rstat"><i />waiting for {run.runnerName}</div>;
  if (run.state === "starting") return <div className="rstat"><i />preparing worktree on {run.runnerName}</div>;
  if (run.state === "working" && !view?.turns.length) return <div className="rstat"><i />starting on {run.runnerName}</div>;
  if (run.state === "landing") return <div className="rstat"><i />pushing</div>;
  const landingError = !!(run.landing as { error?: string | null } | null)?.error;
  if (view?.errors.length && !isLive(run.state) && !landingError) return <div className="rstat bad">{view.errors[view.errors.length - 1]}</div>;
  return null;
}
