import type { Change, ChatActivity, ChatSnapshot, LayerEvent, Message, Presence, Run, WorkspaceState } from "@beam/contracts/layer";
import { LIVE_RUN_STATES } from "@beam/contracts/layer";

/**
 * Snapshots in, events out. Convex sends a query's whole value again whenever it changes; these pure
 * functions say what changed between two values, so a layer can animate an arrival instead of re-rendering
 * a list. The snapshot stays the truth: after a reconnect, start again from the next one.
 */

const byId = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isLive = (r: Run) => LIVE_RUN_STATES.includes(r.state);

/** How one run moved between two readings of it. */
function runEvents(prev: Run | undefined, next: Run): LayerEvent[] {
  if (!prev) return [isLive(next) ? { type: "run.started", run: next } : { type: "run.ended", run: next }];
  const out: LayerEvent[] = [];
  const asked = next.openRequests.filter((id) => !prev.openRequests.includes(id));
  const answered = prev.openRequests.filter((id) => !next.openRequests.includes(id));
  if (asked.length) out.push({ type: "run.asking", run: next, requestIds: asked });
  if (answered.length) out.push({ type: "run.answered", run: next, requestIds: answered });
  if (prev.state !== next.state) out.push(isLive(next) ? { type: "run.changed", run: next, previous: prev.state } : { type: "run.ended", run: next });
  return out;
}

export function diffWorkspace(prev: WorkspaceState, next: WorkspaceState): LayerEvent[] {
  const out: LayerEvent[] = [];
  const before = byId(prev.chats), after = byId(next.chats);
  for (const chat of next.chats) {
    const was = before.get(chat.id);
    if (!was) out.push({ type: "chat.created", chat });
    else if (!same(was, chat)) out.push({ type: "chat.updated", chat, previous: was });
  }
  const status = (s: WorkspaceState, id: string): ChatActivity | "idle" => s.activity[id] ?? "idle";
  for (const id of after.keys()) {
    const from = before.has(id) ? status(prev, id) : "idle", to = status(next, id);
    if (from !== to) out.push({ type: "chat.status", chatId: id, status: to, previous: from });
  }

  const where = (xs: readonly Presence[]) => new Map(xs.map((p) => [p.login, p.chatId]));
  const was = where(prev.presence), is = where(next.presence);
  for (const [login, chatId] of is) {
    if (!was.has(login)) out.push({ type: "person.arrived", login, chatId });
    else if (was.get(login) !== chatId) out.push({ type: "person.moved", login, chatId, previous: was.get(login) ?? null });
  }
  for (const [login, previous] of was) if (!is.has(login)) out.push({ type: "person.left", login, previous });

  const prevRuns = byId([...prev.runs.ended, ...prev.runs.live]);
  const seen = new Set<string>();
  for (const run of [...next.runs.live, ...next.runs.ended]) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const earlier = prevRuns.get(run.id);
    // A chat that just became visible brings its old outcomes along; those are history, not news.
    if (!earlier && !isLive(run) && !before.has(run.chatId)) continue;
    out.push(...runEvents(earlier, run));
  }
  // A run that left the live set without showing up as ended (its chat went away, or it ended out of order).
  for (const run of prev.runs.live) if (!seen.has(run.id) && after.has(run.chatId)) out.push({ type: "run.ended", run });

  for (const id of before.keys()) if (!after.has(id)) out.push({ type: "chat.removed", chatId: id });
  return out;
}

export function diffChat(prev: ChatSnapshot, next: ChatSnapshot): LayerEvent[] {
  const out: LayerEvent[] = [];
  const messages = byId<Message>(prev.messages);
  for (const message of next.messages) {
    const was = messages.get(message.id);
    if (!was) out.push({ type: "message.posted", message });
    else if (!same(was, message)) out.push({ type: "message.updated", message, previous: was });
  }
  const runs = byId<Run>(prev.runs);
  for (const run of next.runs) out.push(...runEvents(runs.get(run.id), run));
  for (const [runId, events] of Object.entries(next.events)) {
    for (const event of events.slice(prev.events[runId]?.length ?? 0)) out.push({ type: "run.event", runId, event });
  }
  const changes = byId<Change>(prev.changes);
  for (const change of next.changes) {
    const was = changes.get(change.id);
    if (!was) out.push({ type: "change.opened", change });
    else if (!same(was, change)) out.push({ type: "change.updated", change, previous: was });
  }
  return out;
}
