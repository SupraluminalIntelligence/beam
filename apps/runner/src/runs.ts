import type { ConvexClient } from "convex/browser";
import type { Agent, RunEvent } from "@beam/contracts";
import { adapters, type Session } from "@beam/harness";
import { branchName, checkpointAndPush, compareUrl, defaultBranch, diffStat, draftPullRequest, ensureMirror, ensureWorktree } from "@beam/git";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

interface Detail {
  run: { _id: Id<"runs">; branch: string | null; resumeCursor: unknown };
  chat: { _id: Id<"chats">; workspaceId: Id<"workspaces">; title: string; repo: string | null; activeBranch: string | null };
  agent: { _id: Id<"agents">; harness: string; handle: string; model: string; effort: string; permissionMode: string; alwaysAllow: string[]; contextPolicy: string; workspaceId: Id<"workspaces"> };
  dispatch: { _id: Id<"messages">; text: string; author: string };
  transcript: { author: string; text: string; kind: string; _creationTime: number }[];
  previous: { resumeCursor: unknown; worktree: string | null } | null;
  agents: { id: Id<"agents">; handle: string; harness: string }[];
}

const log = (runId: string, ...a: unknown[]) => console.log(`[run ${runId.slice(-6)}]`, ...a);
const stripMention = (text: string, handle: string) => text.replace(new RegExp(`(^|\\s)@${handle}\\b`, "gi"), "$1").trim();

/** Watch for runs assigned to this runner and host each one to its landing. */
export function watchRuns(client: ConvexClient, token: string) {
  const active = new Map<string, Promise<void>>();
  client.onUpdate(api.runs.queuedFor, { token }, (runs) => {
    for (const r of runs) {
      if (active.has(r._id)) continue;
      const p = hostRun(client, token, r._id).catch((e) => console.error(`[run ${r._id.slice(-6)}] crashed`, e)).finally(() => active.delete(r._id));
      active.set(r._id, p);
    }
  });
  return { active };
}

async function hostRun(client: ConvexClient, token: string, runId: Id<"runs">) {
  const d = (await client.query(api.runs.detail, { token, runId })) as Detail;
  const { chat, agent, dispatch } = d;
  const repo = chat.repo;
  if (!repo) return land(client, token, runId, "failed", null, null, "chat has no repo");
  log(runId, `dispatch from ${dispatch.author} → @${agent.handle} on ${repo}`);

  // 1. Worktree on the chat's branch. First run names the branch; later runs reuse it.
  let base = "main", branch = chat.activeBranch ?? d.run.branch ?? branchName(chat.title, runId), wt: string;
  try {
    await ensureMirror(repo);
    base = await defaultBranch(repo);
    wt = await ensureWorktree(repo, chat.workspaceId, chat._id, branch, base);
  } catch (e) {
    return land(client, token, runId, "failed", null, null, `could not prepare worktree: ${(e as Error).message}`);
  }
  await client.mutation(api.runs.claim, { token, runId, branch, worktree: wt });

  // 2. Start the harness with the chat as context.
  const adapter = adapters[agent.harness as keyof typeof adapters];
  if (!adapter) return land(client, token, runId, "failed", branch, base, `no adapter for ${agent.harness}`);
  const agentView: Agent = { id: agent._id as never, workspaceId: agent.workspaceId as never, harness: agent.harness as never, handle: agent.handle, model: agent.model, effort: agent.effort as never, permissionMode: agent.permissionMode as never, alwaysAllow: agent.alwaysAllow, contextPolicy: agent.contextPolicy as never };
  const sameWorktree = d.previous?.worktree === wt;
  const resumeCursor = sameWorktree ? d.previous?.resumeCursor ?? null : null;
  const systemContext = renderContext(d, branch);
  let session: Session;
  try {
    session = await adapter.start({ runId, agent: agentView, cwd: wt, resumeCursor, systemContext });
  } catch (e) {
    return land(client, token, runId, "failed", branch, base, `${agent.harness} failed to start: ${(e as Error).message}`);
  }

  // 3. Event pump → Convex. Text streams into one message per turn; everything else is a run event.
  const batch: RunEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = async () => {
    flushTimer = null;
    if (!batch.length) return;
    const events = batch.splice(0).map((e) => ({ ...e, at: Date.now() }));
    await client.mutation(api.runs.appendEvents, { token, runId, events }).catch((e) => log(runId, "appendEvents failed", (e as Error).message));
  };
  const queue = (e: RunEvent) => { batch.push(e); if (!flushTimer) flushTimer = setTimeout(() => void flush(), 100); };

  const said = new Map<string, { id: Id<"messages"> | Promise<Id<"messages">>; text: string; timer: NodeJS.Timeout | null; dirty: boolean }>();
  const sayFlush = async (key: string) => {
    const s = said.get(key); if (!s) return;
    s.timer = null;
    if (!s.dirty) return;
    s.dirty = false;
    const id = await s.id;
    await client.mutation(api.runs.patchSay, { token, messageId: id, text: s.text }).catch((e) => log(runId, "patchSay failed", (e as Error).message));
  };
  const say = (key: string, turn: number, text: string, final: boolean) => {
    let s = said.get(key);
    if (!s) { s = { id: client.mutation(api.runs.say, { token, runId, turn, text }), text, timer: null, dirty: false }; said.set(key, s); return; }
    s.text = text; s.dirty = true;
    if (final) { if (s.timer) clearTimeout(s.timer); void sayFlush(key); }
    else if (!s.timer) s.timer = setTimeout(() => void sayFlush(key), 150);
  };

  let turn = 0, openTurns = 0, ended = false, state = "landed", cursor: unknown = resumeCursor;
  const turnDone = new Promise<void>((res) => {
    void (async () => {
      for await (const e of session.events) {
        switch (e.type) {
          case "session.started": cursor = e.resumeCursor; queue(e); break;
          case "turn.started": turn += 1; queue(e); break;
          case "content.delta": { const s = said.get(e.messageId); say(e.messageId, turn, (s?.text ?? "") + e.delta, false); break; }
          case "content.final": say(e.messageId, turn, e.text, true); break;
          case "turn.completed": queue(e); openTurns -= 1; if (openTurns <= 0 && !steersPending()) { ended = true; res(); } break;
          case "error": queue(e); if (e.fatal) { state = "failed"; ended = true; res(); } break;
          default: queue(e);
        }
      }
      if (!ended) { ended = true; res(); }
    })();
  });

  // 4. Control: steers, approvals, and stop requests from anyone in the chat.
  const seenSteers = new Set<string>(), seenResolutions = new Set<string>();
  let queuedSteers: { id: string; text: string }[] = [];
  const steersPending = () => queuedSteers.length > 0;
  const deliver = async () => {
    while (queuedSteers.length && !ended) {
      const s = queuedSteers.shift()!;
      openTurns += 1;
      await session.send(stripMention(s.text, agent.handle), s.id);
    }
  };
  let interrupting = false;
  const unsubscribe = client.onUpdate(api.runs.control, { token, runId }, (c) => {
    if (!c) return;
    for (const s of c.steers) if (!seenSteers.has(s.id)) { seenSteers.add(s.id); queuedSteers.push({ id: s.id, text: s.text }); log(runId, `steer from ${s.author}`); }
    if (queuedSteers.length) void deliver();
    for (const r of c.resolutions) if (!seenResolutions.has(r.requestId)) { seenResolutions.add(r.requestId); void session.respond(r.requestId, r.decision, r.by); }
    if (c.interruptRequestedAt && !interrupting) { interrupting = true; state = "interrupted"; log(runId, "interrupt requested"); void session.interrupt().then(() => { ended = true; }); }
  });

  // 5. First turn: the dispatch itself.
  openTurns = 1;
  await session.send(stripMention(dispatch.text, agent.handle), dispatch._id);
  await Promise.race([turnDone, new Promise<void>((res) => { const t = setInterval(() => { if (ended) { clearInterval(t); res(); } }, 500); })]);
  unsubscribe();
  await session.stop();
  cursor = session.resumeCursor() ?? cursor;
  if (flushTimer) clearTimeout(flushTimer);
  await flush();
  for (const key of said.keys()) await sayFlush(key);

  // 6. Land: commit, push, draft PR. Always, even after a failure or interrupt.
  await land(client, token, runId, state, branch, base, null, { wt, repo, title: chat.title, cursor });
}

async function land(client: ConvexClient, token: string, runId: Id<"runs">, state: string, branch: string | null, base: string | null, error: string | null,
  push?: { wt: string; repo: string; title: string; cursor: unknown }) {
  let landing = branch && base ? { branch, base, pushed: false, add: 0, del: 0, files: 0, prUrl: null as string | null, compareUrl: null as string | null, error } : null;
  if (push && landing) {
    try {
      const { committed } = await checkpointAndPush(push.wt, landing.branch, `${push.title}\n\nRun in Beam · ${runId}`);
      const stat = await diffStat(push.wt, `origin/${landing.base}`);
      landing = { ...landing, pushed: true, ...stat, compareUrl: compareUrl(push.repo, landing.base, landing.branch) };
      if (stat.files > 0) landing.prUrl = await draftPullRequest(push.wt, push.repo, landing.branch, landing.base, push.title, `Opened from Beam.\n\n${committed ? "Changes were committed at the end of the run." : ""}`);
      log(runId, `landed · ${landing.branch} · +${stat.add} −${stat.del} · ${stat.files} files${landing.prUrl ? ` · ${landing.prUrl}` : ""}`);
    } catch (e) {
      landing = { ...landing, error: `push failed: ${(e as Error).message}` };
      log(runId, "push failed", (e as Error).message);
    }
  } else if (error) log(runId, "failed:", error);
  if (error && landing === null) await client.mutation(api.runs.appendEvents, { token, runId, events: [{ type: "error", runId, message: error, fatal: true, at: Date.now() }] }).catch(() => {});
  await client.mutation(api.runs.land, { token, runId, state, landing, resumeCursor: push?.cursor ?? null });
}

/** The chat so far, rendered for the harness. Names are handles; the agent's own messages are marked. */
function renderContext(d: Detail, branch: string): string {
  const who = (author: string) => {
    if (!author.startsWith("agent:")) return `@${author}`;
    const a = d.agents.find((x) => `agent:${x.id}` === author);
    return a ? `@${a.handle}${a.id === d.agent._id ? " (you)" : ""}` : "@agent";
  };
  const lines = d.transcript.filter((m) => m.text.trim()).map((m) => `${who(m.author)}: ${m.text.trim()}`);
  const head = [
    `You are @${d.agent.handle}, a coding agent in a Beam chat called "${d.chat.title}" with a team of people.`,
    `You work in a git worktree on branch ${branch}. Do not switch branches, and do not push: Beam commits and pushes for you when the run ends.`,
    `Keep replies short and conversational, like a colleague reporting back. Say what you changed and anything the team should decide.`,
    `When you are done, stop. A person will @mention you again if they want more.`,
  ];
  return lines.length ? `${head.join("\n")}\n\nChat so far:\n${lines.join("\n")}` : head.join("\n");
}
