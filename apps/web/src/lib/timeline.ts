import type { RunView, TurnView } from "@beam/reducer";

type Message = { _id: string; _creationTime: number; author: string; kind: string; text: string; runId: string | null; turn?: number };
type Run = { _id: string; _creationTime: number; agentId: string; dispatchMessageId: string; state: string; startedAt: number | null; endedAt: number | null; landing: unknown };
type Base = { key: string; at: number; author: string; cont: boolean; live: boolean };
export type TimelineRow<M, R> = Base & (
  { kind: "message"; message: M } |
  { kind: "activity"; run: R; turn: TurnView } |
  { kind: "status" | "landing"; run: R }
);
const live = (r: Run) => ["queued", "starting", "working", "landing"].includes(r.state);

/** Merge human messages, reply segments and tool starts; completions update rows in place. */
export function timeline<M extends Message, R extends Run>(messages: readonly M[], runs: readonly R[], views: Record<string, RunView>): TimelineRow<M, R>[] {
  const rows: TimelineRow<M, R>[] = messages.filter((m) => m.kind !== "report" || m.text.trim()).map((message) => ({
    kind: "message", key: message._id, message, author: message.author,
    at: message.runId ? views[message.runId]?.messageStarts[message._id] ?? message._creationTime : message._creationTime,
    cont: false, live: false,
  }));
  for (const run of runs) {
    const view = views[run._id];
    for (const turn of view?.turns ?? []) for (const step of turn.activity) rows.push({
      kind: "activity", key: `${run._id}:${step.itemId}`, run, turn: { ...turn, activity: [step] },
      author: `agent:${run.agentId}`, at: step.startedAt ?? turn.startedAt ?? run.startedAt ?? run._creationTime,
      cont: false, live: false,
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const grouped: TimelineRow<M, R>[] = [];
  for (const row of rows) {
    const prev = grouped.at(-1);
    if (row.kind === "activity" && prev?.kind === "activity" && row.run._id === prev.run._id && row.turn.turn === prev.turn.turn) {
      prev.turn.activity.push(...row.turn.activity);
    } else grouped.push(row);
  }
  for (const row of grouped) if (row.kind === "activity") {
    const steps = row.turn.activity;
    row.turn.startedAt = steps[0]?.startedAt ?? row.turn.startedAt;
    row.turn.endedAt = steps.every((s) => s.ok !== null && s.startedAt !== null && s.ms !== null)
      ? Math.max(...steps.map((s) => s.startedAt! + s.ms!)) : null;
  }
  const lastContent = new Map<string, TimelineRow<M, R>>();
  for (const row of grouped) {
    if (row.kind === "activity") lastContent.set(row.run._id, row);
    if (row.kind === "message" && row.message.kind === "report" && row.message.runId) lastContent.set(row.message.runId, row);
  }
  for (const run of runs) {
    const last = lastContent.get(run._id);
    if (last && live(run)) last.live = last.kind === "activity" ? !last.turn.done : last.kind === "message" && !views[run._id]?.turns.find((t) => t.turn === last.message.turn)?.done;
    for (const row of grouped) if (row.kind === "activity" && row.run._id === run._id && live(run) && row.turn.activity.some((s) => s.ok === null)) row.live = true;
    if (live(run)) {
      grouped.push({ kind: "status", key: `status:${run._id}`, run, at: Math.max(run._creationTime, ...rows.map((r) => r.at)) + 1, author: `agent:${run.agentId}`, cont: false, live: true });
    } else {
      const landing = run.landing as { repos?: unknown[]; error?: string } | null;
      if (landing?.repos?.length || landing?.error || views[run._id]?.errors.length || ["failed", "interrupted"].includes(run.state)) {
        const lastStep = rows.filter((r) => r.kind === "activity" && r.run._id === run._id).at(-1)?.at ?? 0;
        grouped.push({ kind: "landing", key: `landing:${run._id}`, run, at: Math.max(run.endedAt ?? run._creationTime, last?.at ?? 0, lastStep) + 0.1, author: `agent:${run.agentId}`, cont: false, live: false });
      }
    }
  }
  grouped.sort((a, b) => a.at - b.at);
  let previous: string | null = null;
  for (const row of grouped) {
    const identity = row.author.startsWith("agent:") ? `${row.author}:${row.kind === "message" ? row.message.runId : row.run._id}` : row.author;
    row.cont = identity === previous; previous = identity;
  }
  return grouped;
}
