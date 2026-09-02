import { useMutation } from "convex/react";
import { useState } from "react";
import type { ActivityLine, RunView, TurnView } from "@beam/reducer";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";

type Run = Doc<"runs"> & { runnerName: string };
export const isLive = (state: string) => state === "queued" || state === "starting" || state === "working" || state === "landing";

const ms = (n: number | null) => (n == null ? "" : n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n / 60_000)}m`);
const span = (t: TurnView) => (t.startedAt && t.endedAt ? ms(t.endedAt - t.startedAt) : "");

const KIND_LABEL: Record<string, string> = { bash: "run", read: "read", edit: "edit", write: "write", search: "find", web: "web", agent: "agent", plan: "plan", ask: "ask", beam: "beam" };

/** One tool call: status square, kind, one clipped line, timing. Click for the full command and its output. */
function Step({ a }: { a: ActivityLine }) {
  const [open, setOpen] = useState(false);
  const label = KIND_LABEL[a.kind] ?? a.kind.slice(0, 5);
  // "Read src/x.ts" → the file, since the kind column already says read
  const text = a.kind === "bash" ? a.summary : a.summary.replace(/^(Read|Edit|Write|Grep|Glob|List|Fetch|Search|Subagent · )\s*/, "");
  return (
    <div className={`step${open ? " open" : ""}`}>
      <button className="stepline" onClick={() => setOpen(!open)} title={open ? "collapse" : "show full command and output"}>
        <span className={`sq ${a.ok === null ? "run" : a.ok ? "ok" : "bad"}`} />
        <span className="kind">{label}</span>
        <span className="what">{text}</span>
        <span className="r">{ms(a.ms)}</span>
      </button>
      {open && <div className="stepdetail">
        {a.kind === "bash" && <pre className="cmd">{a.summary}</pre>}
        <pre className="out">{a.detail ?? (a.ok === null ? "still running" : "no output")}</pre>
      </div>}
    </div>
  );
}

/** One turn's tool calls. Open while it runs, folded once it is done. */
export function Activity({ t, live, agentName }: { t: TurnView; live: boolean; agentName: string }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? live;
  if (!t.activity.length && !live) return null;
  const n = t.activity.length;
  const title = live ? (n ? `${agentName} is working · ${n} step${n === 1 ? "" : "s"}` : `${agentName} is thinking`) : `${n} step${n === 1 ? "" : "s"}`;
  return (
    <div className={`act${isOpen ? "" : " closed"}`}>
      <button className="ah" onClick={() => setOpen(!isOpen)}>
        <span className="tog">{isOpen ? "▾" : "▸"}</span><span>{title}</span>
        <span className={`st ${live ? "work" : "done"}`}><i />{live ? "" : span(t)}</span>
      </button>
      <div className="stepwrap"><div className="steps">
        {t.activity.map((a) => <Step key={a.itemId} a={a} />)}
      </div></div>
    </div>
  );
}

/** A question the agent is waiting on. Anyone in the chat can answer; the first answer wins. */
export function Requests({ view, turn, runId }: { view: RunView; turn: number; runId: Id<"runs"> }) {
  const respond = useMutation(api.runs.respond);
  const open = view.requests.filter((r) => r.turn === turn);
  if (!open.length) return null;
  return <>{open.map((r) => (
    <div key={r.requestId} className="ask">
      <div className="askp"><span className="k">waiting for approval</span><span>{r.prompt}</span></div>
      <div className="perm">{(r.options ?? ["allow", "deny"]).map((o) => <button key={o} onClick={() => void respond({ runId, requestId: r.requestId, decision: o }).catch((e) => toast(String((e as Error).message)))}>{o}</button>)}</div>
    </div>
  ))}</>;
}

/** What a run left behind: the branch, the diff size, and the PR if `gh` could open one. */
export function LandingCard({ run }: { run: Run }) {
  const l = run.landing as null | { branch: string; base: string; pushed: boolean; add: number; del: number; files: number; prUrl: string | null; compareUrl: string | null; error: string | null };
  if (!l) return run.state === "failed" ? <div className="ask fail"><span className="k">run failed</span><span>See the log above. Nothing was pushed.</span></div> : null;
  const href = l.prUrl ?? l.compareUrl;
  const open = () => { if (href) (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam?.openExternal?.(href) ?? window.open(href, "_blank"); };
  return (
    <button className="card" onClick={open} title={href ?? undefined}>
      <span className="ai">⎇</span>
      <div>
        <div className="ttl">{l.branch}</div>
        <div className="mt">
          <span>{run.state === "interrupted" ? "stopped" : run.state === "failed" ? "failed" : l.pushed ? "pushed" : "not pushed"}</span>
          {l.pushed && <><span className="add">+{l.add}</span><span className="del">−{l.del}</span><span>{l.files} file{l.files === 1 ? "" : "s"}</span></>}
          {l.error && <span className="err">{l.error}</span>}
          {href && <span className="hint">{l.prUrl ? "open draft PR" : "compare on GitHub"}</span>}
        </div>
      </div>
    </button>
  );
}

/** The state line for a run that has not produced text yet. */
export function RunStatus({ run, view }: { run: Run; view: RunView | null }) {
  if (run.state === "queued") return <div className="rstat"><i />waiting for {run.runnerName}</div>;
  if (run.state === "starting") return <div className="rstat"><i />preparing worktree on {run.runnerName}</div>;
  if (run.state === "working" && !view?.turns.length) return <div className="rstat"><i />starting on {run.runnerName}</div>;
  if (run.state === "landing") return <div className="rstat"><i />pushing {run.branch}</div>;
  if (view?.errors.length && (run.state === "failed" || !isLive(run.state))) return <div className="rstat bad">{view.errors[view.errors.length - 1]}</div>;
  return null;
}
