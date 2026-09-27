import type { Author, ChatSnapshot, Message, Run, RunEvent } from "@beam/contracts/layer";
import { fold, timeline as mergeTimeline, type ActivityLine, type OpenRequest, type RunView, type TurnView } from "@beam/reducer";

/**
 * The meaning the plain apps derive, ready for any interface: a run's turns and tool steps, and a chat as
 * one ordered list. The same reducer the desktop and phone apps use, so every layer agrees with them.
 */

export type { ActivityLine, OpenRequest, RunView, TurnView };

/** Fold a run's events: text per reply, tool steps per turn, open questions, errors. */
export const runView = (runId: string, events: readonly RunEvent[]): RunView => fold(runId, events as never);

export type TimelineRow =
  | { kind: "message"; key: string; at: number; message: Message; live: boolean; continued: boolean }
  | { kind: "activity"; key: string; at: number; run: Run; turn: TurnView; live: boolean; continued: boolean }
  | { kind: "status" | "landing"; key: string; at: number; run: Run; live: boolean; continued: boolean };

export const authorKey = (a: Author) => a.type === "agent" ? `agent:${a.agentId}` : a.login;

/**
 * A chat as people read it: human messages, agent replies and tool steps in order, with a status row for
 * each live run and a landing row for each finished one. `continued` marks a row from the same speaker.
 */
export function chatTimeline(chat: Pick<ChatSnapshot, "messages" | "runs" | "events">): TimelineRow[] {
  const views: Record<string, RunView> = {};
  for (const run of chat.runs) views[run.id] = runView(run.id, chat.events[run.id] ?? []);
  const messages = chat.messages.map((m) => ({ _id: m.id, _creationTime: m.createdAt, author: authorKey(m.author), kind: m.kind, text: m.text, runId: m.runId, ...(m.turn === null ? {} : { turn: m.turn }), source: m }));
  const runs = chat.runs.map((r) => ({ _id: r.id, _creationTime: r.createdAt, agentId: r.agentId, dispatchMessageId: r.dispatchMessageId, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, landing: r.landing, source: r }));
  return mergeTimeline(messages, runs, views).map((row): TimelineRow => {
    const base = { key: row.key, at: row.at, live: row.live, continued: row.cont };
    if (row.kind === "message") return { ...base, kind: "message", message: row.message.source };
    if (row.kind === "activity") return { ...base, kind: "activity", run: row.run.source, turn: row.turn };
    return { ...base, kind: row.kind, run: row.run.source };
  });
}

/** Questions and approvals an agent is waiting on in a chat, oldest first, with who can see them answered. */
export function openRequests(chat: Pick<ChatSnapshot, "runs" | "events">): (OpenRequest & { run: Run })[] {
  return chat.runs.flatMap((run) => runView(run.id, chat.events[run.id] ?? []).requests.map((r) => ({ ...r, run })));
}
