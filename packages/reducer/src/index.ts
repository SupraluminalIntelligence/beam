import type { RunEvent } from "@beam/contracts";

/** What the UI renders under one agent turn. Pure data, no provider shapes. */
export interface ActivityLine { itemId: string; summary: string; detail: string | null; ok: boolean | null; ms: number | null }
export interface OpenRequest { requestId: string; kind: "approval" | "input"; prompt: string; options: string[] | null }
export interface RunView {
  runId: string;
  status: "working" | "done" | "failed";
  text: Record<string, string>; // messageId -> accumulated text
  activity: ActivityLine[];
  requests: OpenRequest[];
  resolved: Record<string, { by: string; decision: string }>;
}

export const emptyRun = (runId: string): RunView => ({ runId, status: "working", text: {}, activity: [], requests: [], resolved: {} });

/** Fold one event into a run view. Pure. */
export function apply(view: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "content.delta":
      return { ...view, text: { ...view.text, [e.messageId]: (view.text[e.messageId] ?? "") + e.delta } };
    case "content.final":
      return { ...view, text: { ...view.text, [e.messageId]: e.text } };
    case "item.started":
      return { ...view, activity: [...view.activity, { itemId: e.itemId, summary: e.summary, detail: null, ok: null, ms: null }] };
    case "item.completed":
      return {
        ...view,
        activity: view.activity.some((a) => a.itemId === e.itemId)
          ? view.activity.map((a) => (a.itemId === e.itemId ? { ...a, summary: e.summary, detail: e.detail, ok: e.ok, ms: e.ms } : a))
          : [...view.activity, { itemId: e.itemId, summary: e.summary, detail: e.detail, ok: e.ok, ms: e.ms }],
      };
    case "request.opened":
      return { ...view, requests: [...view.requests, { requestId: e.requestId, kind: e.kind, prompt: e.prompt, options: e.options }] };
    case "request.resolved":
      return { ...view, requests: view.requests.filter((r) => r.requestId !== e.requestId), resolved: { ...view.resolved, [e.requestId]: { by: e.by, decision: e.decision } } };
    case "error":
      return e.fatal ? { ...view, status: "failed" } : view;
    case "turn.completed":
      return { ...view, status: "done" };
    default:
      return view;
  }
}

export const fold = (runId: string, events: readonly RunEvent[]): RunView => events.reduce(apply, emptyRun(runId));
