import type { RunEvent } from "@beam/contracts";

/** What the UI renders under one agent turn. Pure data, no provider shapes. */
export interface ActivityLine { itemId: string; kind: string; summary: string; detail: string | null; ok: boolean | null; ms: number | null; startedAt: number | null }
export interface OpenRequest { requestId: string; kind: "approval" | "input"; prompt: string; options: string[] | null; turn: number }
export interface TurnView { turn: number; turnId: string; activity: ActivityLine[]; done: boolean; startedAt: number | null; endedAt: number | null }
export interface RunView {
  runId: string;
  status: "working" | "done" | "failed";
  text: Record<string, string>; // messageId -> accumulated text
  messageStarts: Record<string, number>; // persisted reply segment -> original event time
  activity: ActivityLine[];     // every turn, flat
  turns: TurnView[];            // per turn, 1-based
  requests: OpenRequest[];
  resolved: Record<string, { by: string; decision: string }>;
  errors: string[];
  resumeCursor: unknown;
  lastAt: number | null;   // when the runner last reported anything for this run
  queuedSteers: number;    // steers handed over but not yet started as a turn
  note: string | null;     // what the harness says it is waiting on, if anything
}

export const emptyRun = (runId: string): RunView => ({ runId, status: "working", text: {}, messageStarts: {}, activity: [], turns: [], requests: [], resolved: {}, errors: [], resumeCursor: null, lastAt: null, queuedSteers: 0, note: null });

const currentTurn = (view: RunView): TurnView => view.turns[view.turns.length - 1] ?? { turn: 1, turnId: "turn1", activity: [], done: false, startedAt: null, endedAt: null };
const withTurn = (view: RunView, t: TurnView): RunView => {
  const i = view.turns.findIndex((x) => x.turn === t.turn);
  return { ...view, turns: i < 0 ? [...view.turns, t] : view.turns.map((x) => (x.turn === t.turn ? t : x)) };
};
const upsert = (lines: ActivityLine[], line: ActivityLine) =>
  lines.some((a) => a.itemId === line.itemId) ? lines.map((a) => (a.itemId === line.itemId ? { ...a, ...line, kind: line.kind || a.kind, summary: line.summary || a.summary, startedAt: line.startedAt ?? a.startedAt } : a)) : [...lines, line];

/** Fold one event into a run view. Pure. */
export function apply(prev: RunView, e: RunEvent & { at?: number }): RunView {
  const stamped = e.at ? { ...prev, lastAt: Math.max(prev.lastAt ?? 0, e.at) } : prev;
  // progress of any kind clears a waiting note
  const view = e.type === "status" || e.type === "request.resolved" ? stamped : { ...stamped, note: null };
  switch (e.type) {
    case "message.started":
      return { ...view, messageStarts: { ...view.messageStarts, [e.messageId]: e.at ?? view.lastAt ?? 0 } };
    case "status":
      return { ...view, note: e.message };
    case "session.started":
      return { ...view, resumeCursor: e.resumeCursor };
    case "turn.started": {
      const n = view.turns.length + 1;
      return withTurn({ ...view, status: "working", queuedSteers: Math.max(0, view.queuedSteers - (n > 1 ? 1 : 0)) }, { turn: n, turnId: e.turnId, activity: [], done: false, startedAt: e.at ?? null, endedAt: null });
    }
    case "content.delta":
      return { ...view, text: { ...view.text, [e.messageId]: (view.text[e.messageId] ?? "") + e.delta } };
    case "content.final":
      return { ...view, text: { ...view.text, [e.messageId]: e.text } };
    case "item.started": {
      const line = { itemId: e.itemId, kind: e.kind, summary: e.summary, detail: null, ok: null, ms: null, startedAt: e.at ?? null };
      const t = currentTurn(view);
      return withTurn({ ...view, activity: upsert(view.activity, line) }, { ...t, activity: upsert(t.activity, line) });
    }
    case "item.completed": {
      const line = { itemId: e.itemId, kind: "", summary: e.summary, detail: e.detail, ok: e.ok, ms: e.ms, startedAt: null };
      const owner = view.turns.find((t) => t.activity.some((a) => a.itemId === e.itemId)) ?? currentTurn(view);
      return withTurn({ ...view, activity: upsert(view.activity, line) }, { ...owner, activity: upsert(owner.activity, line) });
    }
    case "request.opened":
      return { ...view, requests: [...view.requests, { requestId: e.requestId, kind: e.kind, prompt: e.prompt, options: e.options, turn: currentTurn(view).turn }] };
    case "request.resolved":
      return { ...view, requests: view.requests.filter((r) => r.requestId !== e.requestId), resolved: { ...view.resolved, [e.requestId]: { by: e.by, decision: e.decision } } };
    case "steer.received":
      return { ...view, queuedSteers: view.queuedSteers + 1 };
    case "error":
      return { ...view, errors: [...view.errors, e.message], status: e.fatal ? "failed" : view.status };
    case "turn.completed": {
      const t = currentTurn(view);
      return withTurn({ ...view, status: "done" }, { ...t, done: true, endedAt: e.at ?? null });
    }
    default:
      return view;
  }
}

export const fold = (runId: string, events: readonly RunEvent[]): RunView => events.reduce(apply, emptyRun(runId));
