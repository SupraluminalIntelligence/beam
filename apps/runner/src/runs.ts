import type { ConvexClient } from "convex/browser";
import type { Agent, RepoLanding, RunEvent } from "@beam/contracts";
import { adapters, type BeamTool, type Session } from "@beam/harness";
import { compareUrl, defaultBranch, draftPullRequest, ensureMirror, ensureRepoWorktree, landRepo, prByNumber, prForBranch, repoDirName, threadBranch, threadDir } from "@beam/git";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

interface Change { _id: Id<"changes">; repo: string; branch: string; base: string; state: string; prUrl: string | null; prNumber: number | null; title: string }
interface Detail {
  run: { _id: Id<"runs">; branch: string | null; resumeCursor: unknown };
  chat: { _id: Id<"chats">; workspaceId: Id<"workspaces">; title: string; repos: string[] };
  agent: { _id: Id<"agents">; harness: string; handle: string; model: string; effort: string; permissionMode: string; alwaysAllow: string[]; contextPolicy: string; workspaceId: Id<"workspaces"> };
  dispatch: { _id: Id<"messages">; text: string; author: string };
  transcript: { author: string; text: string; kind: string; _creationTime: number }[];
  previous: { resumeCursor: unknown; worktree: string | null } | null;
  changes: Change[];
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

/** One repo's place in the thread directory. */
interface RepoSlot { repo: string; dir: string; branch: string; base: string; change: Change | null }

async function hostRun(client: ConvexClient, token: string, runId: Id<"runs">) {
  const d = (await client.query(api.runs.detail, { token, runId })) as Detail;
  const { chat, agent, dispatch } = d;
  log(runId, `dispatch from ${dispatch.author} → @${agent.handle}${chat.repos.length ? ` in ${chat.repos.join(", ")}` : " (no repo yet)"}`);

  // 1. The thread directory: one worktree per repo, each on that repo's open change or a fresh thread branch.
  const dir = threadDir(chat.workspaceId, chat._id);
  await mkdir(dir, { recursive: true });
  const slots = new Map<string, RepoSlot>();
  const changes = [...d.changes];
  const mount = async (repo: string): Promise<RepoSlot> => {
    const have = slots.get(repo);
    if (have) return have;
    await ensureMirror(repo);
    const base = await defaultBranch(repo);
    const open = changes.find((c) => c.repo === repo && c.state === "open") ?? null;
    const resolved = changes.filter((c) => c.repo === repo && c.state !== "open").length;
    const branch = open?.branch ?? threadBranch(chat.title, chat._id, resolved);
    const slotDir = join(dir, repoDirName(repo, [...slots.keys(), repo]));
    await ensureRepoWorktree(repo, slotDir, branch, open?.base ?? base);
    const slot = { repo, dir: slotDir, branch, base: open?.base ?? base, change: open };
    slots.set(repo, slot);
    return slot;
  };
  try { for (const repo of chat.repos) await mount(repo); }
  catch (e) { return land(client, token, runId, "failed", [], `could not prepare a worktree: ${(e as Error).message}`, null); }
  await client.mutation(api.runs.claim, { token, runId, branch: null, worktree: dir });

  // 2. Beam tools: the agent can grow the thread while it works.
  const tools: BeamTool[] = [
    {
      name: "list_repos", description: "List the repos connected to this workspace and which ones are mounted in this thread's directory.",
      schema: {},
      run: async () => { const r = await client.query(api.runs.workspaceRepos, { token, runId }); return `Workspace repos: ${r.repos.join(", ") || "none"}. Mounted in this thread: ${[...slots.values()].map((s) => `${s.repo} → ./${s.dir.slice(dir.length + 1)} (branch ${s.branch})`).join(", ") || "none"}.`; },
    },
    {
      name: "attach_repo", description: "Attach a GitHub repo (owner/name) to this thread. It is cloned into a folder in your working directory right away, on a branch for this thread, and you can start working in it immediately.",
      schema: { repo: z.string().describe("owner/name, e.g. acme/platform") },
      run: async (args) => { const r = await client.mutation(api.runs.attachRepo, { token, runId, repo: String(args["repo"]) }); const s = await mount(r.repo); return `Attached ${r.repo}. It is at ./${s.dir.slice(dir.length + 1)} on branch ${s.branch}.`; },
    },
    {
      name: "adopt_pr", description: "Bring an existing pull request into this thread: its branch is checked out in a folder in your working directory so you can review it or continue it. Use this when asked to review or pick up a PR.",
      schema: { repo: z.string().describe("owner/name"), number: z.number().describe("PR number") },
      run: async (args) => {
        const repo = String(args["repo"]), number = Number(args["number"]);
        const pr = await prByNumber(repo, number);
        if (!pr) throw new Error(`could not read PR #${number} on ${repo}; is \`gh\` signed in on this machine?`);
        await client.mutation(api.changes.adopt, { token, runId, repo, branch: pr.headRefName, base: pr.baseRefName, title: pr.title, prUrl: pr.url, prNumber: pr.number });
        changes.push({ _id: "" as Id<"changes">, repo, branch: pr.headRefName, base: pr.baseRefName, state: "open", prUrl: pr.url, prNumber: pr.number, title: pr.title });
        slots.delete(repo);
        const s = await mount(repo);
        return `PR #${pr.number} "${pr.title}" is checked out at ./${s.dir.slice(dir.length + 1)} on ${pr.headRefName}. Commits you make there land on that PR.`;
      },
    },
    {
      name: "new_pr", description: "Start a fresh pull request for a repo in this thread: the current open change is closed out and the next landing goes to a new branch. Use it when someone asks to split work into a separate PR.",
      schema: { repo: z.string().describe("owner/name") },
      run: async (args) => {
        const repo = String(args["repo"]);
        await client.mutation(api.changes.rotate, { token, runId, repo });
        for (const c of changes) if (c.repo === repo && c.state === "open") c.state = "closed";
        slots.delete(repo);
        const s = await mount(repo);
        return `Next landing on ${repo} goes to a new branch, ${s.branch}. The folder ./${s.dir.slice(dir.length + 1)} is now on it.`;
      },
    },
  ];

  // 3. Start the harness in the thread directory with the chat as context.
  const adapter = adapters[agent.harness as keyof typeof adapters];
  if (!adapter) return land(client, token, runId, "failed", [], `no adapter for ${agent.harness}`, null);
  const agentView: Agent = { id: agent._id as never, workspaceId: agent.workspaceId as never, harness: agent.harness as never, handle: agent.handle, model: agent.model, effort: agent.effort as never, permissionMode: agent.permissionMode as never, alwaysAllow: agent.alwaysAllow, contextPolicy: agent.contextPolicy as never };
  const resumeCursor = d.previous?.worktree === dir ? d.previous?.resumeCursor ?? null : null;
  let session: Session;
  try {
    session = await adapter.start({ runId, agent: agentView, cwd: dir, resumeCursor, systemContext: renderContext(d, dir, slots), tools });
  } catch (e) {
    return land(client, token, runId, "failed", [], `${agent.harness} failed to start: ${(e as Error).message}`, null);
  }

  // 4. Event pump → Convex. Text streams into one message per turn; everything else is a run event.
  const batch: RunEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = async () => {
    flushTimer = null;
    if (!batch.length) return;
    const events = batch.splice(0).map((e) => ({ ...e, at: Date.now() }));
    await client.mutation(api.runs.appendEvents, { token, runId, events }).catch((e) => log(runId, "appendEvents failed", (e as Error).message));
  };
  const queue = (e: RunEvent) => { batch.push(e); if (!flushTimer) flushTimer = setTimeout(() => void flush(), 100); };

  const SAY_MS = 60;
  const said = new Map<string, { id: Promise<Id<"messages">>; text: string; sent: string; timer: NodeJS.Timeout | null; inflight: boolean }>();
  const sayFlush = async (key: string) => {
    const s = said.get(key); if (!s) return;
    s.timer = null;
    if (s.inflight || s.text === s.sent) return;
    s.inflight = true;
    const text = s.text;
    try { await client.mutation(api.runs.patchSay, { token, messageId: await s.id, text }); s.sent = text; }
    catch (e) { log(runId, "patchSay failed", (e as Error).message); }
    finally { s.inflight = false; if (s.text !== s.sent && !s.timer) s.timer = setTimeout(() => void sayFlush(key), SAY_MS); }
  };
  const say = (key: string, turn: number, text: string, final: boolean) => {
    let s = said.get(key);
    if (!s) { s = { id: client.mutation(api.runs.say, { token, runId, turn, text }), text, sent: text, timer: null, inflight: false }; said.set(key, s); return; }
    s.text = text;
    if (final) { if (s.timer) { clearTimeout(s.timer); s.timer = null; } void sayFlush(key); }
    else if (!s.timer && !s.inflight) s.timer = setTimeout(() => void sayFlush(key), SAY_MS);
  };

  let turn = 0, openTurns = 0, ended = false, state = "landed", cursor: unknown = resumeCursor;
  let lastEventAt = Date.now(), waitingOnPerson = 0;
  const SILENCE_MS = 15 * 60_000;
  const turnDone = new Promise<void>((res) => {
    void (async () => {
      for await (const e of session.events) {
        lastEventAt = Date.now();
        if (e.type === "request.opened") waitingOnPerson += 1;
        if (e.type === "request.resolved") waitingOnPerson = Math.max(0, waitingOnPerson - 1);
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

  // 5. Control: steers, approvals, and stop requests from anyone in the chat.
  const seenSteers = new Set<string>(), seenResolutions = new Set<string>();
  const queuedSteers: { id: string; text: string }[] = [];
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
    if (c.interruptRequestedAt && !interrupting) {
      interrupting = true; state = "interrupted"; log(runId, "interrupt requested");
      // Ask nicely, then insist: a hung harness never answers an interrupt.
      const deadline = setTimeout(() => { if (!ended) { log(runId, "interrupt not acknowledged in 10s, forcing"); ended = true; } }, 10_000);
      void session.interrupt().then(() => { clearTimeout(deadline); ended = true; }, () => { clearTimeout(deadline); ended = true; });
    }
  });
  // Watchdog: a harness that says nothing for a long time, with no question pending, is treated as hung.
  const watchdog = setInterval(() => {
    if (ended || waitingOnPerson > 0 || Date.now() - lastEventAt < SILENCE_MS) return;
    log(runId, `no output for ${Math.round(SILENCE_MS / 60_000)} minutes, ending the run`);
    queue({ type: "error", runId: runId as never, message: `${agent.harness} produced nothing for ${Math.round(SILENCE_MS / 60_000)} minutes; the run was ended`, fatal: true });
    state = "failed"; ended = true;
    void session.interrupt().catch(() => {});
  }, 30_000);

  // 6. First turn: the dispatch itself.
  openTurns = 1;
  await session.send(stripMention(dispatch.text, agent.handle), dispatch._id);
  await Promise.race([turnDone, new Promise<void>((res) => { const t = setInterval(() => { if (ended) { clearInterval(t); res(); } }, 500); })]);
  unsubscribe();
  clearInterval(watchdog);
  await Promise.race([session.stop(), new Promise((r) => setTimeout(r, 5000))]);
  cursor = session.resumeCursor() ?? cursor;
  if (flushTimer) clearTimeout(flushTimer);
  await flush();
  for (const key of said.keys()) { const s = said.get(key)!; if (s.timer) clearTimeout(s.timer); while (s.inflight) await new Promise((r) => setTimeout(r, 20)); await sayFlush(key); while (s.inflight) await new Promise((r) => setTimeout(r, 20)); }

  // 7. Land every repo that changed: commit, push, open or update its PR. Always, even after a failure or interrupt.
  const landings: RepoLanding[] = [];
  for (const s of slots.values()) {
    try {
      const r = await landRepo(s.dir, s.branch, s.base, `${chat.title}\n\nRun in Beam · ${runId}`);
      if (!r.pushed) continue;
      let pr = s.change?.prUrl ? { url: s.change.prUrl, number: s.change.prNumber } : await prForBranch(s.repo, s.branch).then((p) => (p ? { url: p.url, number: p.number } : null));
      if (!pr && r.files > 0) { const url = await draftPullRequest(s.dir, s.repo, s.branch, s.base, chat.title, "Opened from Beam."); if (url) pr = { url, number: Number(url.split("/").pop()) || null }; }
      await client.mutation(api.changes.land, { token, runId, repo: s.repo, branch: s.branch, base: s.base, title: chat.title, add: r.add, del: r.del, files: r.files, prUrl: pr?.url ?? null, prNumber: pr?.number ?? null });
      landings.push({ repo: s.repo, branch: s.branch, base: s.base, pushed: true, add: r.add, del: r.del, files: r.files, prUrl: pr?.url ?? null, compareUrl: compareUrl(s.repo, s.base, s.branch), error: null });
      log(runId, `landed ${s.repo} · ${s.branch} · +${r.add} −${r.del} · ${r.files} files${pr ? ` · ${pr.url}` : ""}`);
    } catch (e) {
      landings.push({ repo: s.repo, branch: s.branch, base: s.base, pushed: false, add: 0, del: 0, files: 0, prUrl: null, compareUrl: null, error: `push failed: ${(e as Error).message}` });
      log(runId, `push failed for ${s.repo}`, (e as Error).message);
    }
  }
  await land(client, token, runId, state, landings, null, cursor);
}

async function land(client: ConvexClient, token: string, runId: Id<"runs">, state: string, repos: RepoLanding[], error: string | null, cursor: unknown) {
  if (error) { log(runId, "failed:", error); await client.mutation(api.runs.appendEvents, { token, runId, events: [{ type: "error", runId, message: error, fatal: true, at: Date.now() }] }).catch(() => {}); }
  await client.mutation(api.runs.land, { token, runId, state, landing: { repos, error }, resumeCursor: cursor });
}

/** The thread so far, rendered for the harness: who is here, where the repos are, and what has been said. */
function renderContext(d: Detail, dir: string, slots: Map<string, RepoSlot>): string {
  const who = (author: string) => {
    if (!author.startsWith("agent:")) return `@${author}`;
    const a = d.agents.find((x) => `agent:${x.id}` === author);
    return a ? `@${a.handle}${a.id === d.agent._id ? " (you)" : ""}` : "@agent";
  };
  const lines = d.transcript.filter((m) => m.text.trim()).map((m) => `${who(m.author)}: ${m.text.trim()}`);
  const mounted = [...slots.values()].map((s) => `- ./${s.dir.slice(dir.length + 1)} → ${s.repo}, branch ${s.branch}${s.change?.prUrl ? ` (PR ${s.change.prUrl})` : ""}`);
  const head = [
    `You are @${d.agent.handle}, a coding agent in a Beam thread called "${d.chat.title}" with a team of people.`,
    `Your working directory is the thread's directory. Each repo the thread works in is a folder inside it, on a branch for this thread:`,
    ...(mounted.length ? mounted : ["- (no repos yet: use attach_repo when the work has a home, or adopt_pr to pick up an existing PR)"]),
    `Work inside those folders. Do not switch branches or push: Beam commits and pushes each folder that changed when the run ends, and opens or updates a PR per repo.`,
    `Keep replies short and conversational, like a colleague reporting back. Say what you changed and anything the team should decide.`,
    `When you are done, stop. A person will @mention you again if they want more.`,
  ];
  return lines.length ? `${head.join("\n")}\n\nThread so far:\n${lines.join("\n")}` : head.join("\n");
}
