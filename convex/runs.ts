import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireChat } from "./lib";
import { runnerForToken } from "./runners";

const LIVE = new Set(["queued", "starting", "working", "landing"]);
export const isLive = (state: string) => LIVE.has(state);

async function ownRun(ctx: QueryCtx | MutationCtx, token: string, runId: Id<"runs">) {
  const runner = await runnerForToken(ctx, token);
  const run = await ctx.db.get(runId);
  if (!run || run.runnerId !== runner._id) throw new Error("not this runner's run");
  return { runner, run };
}

// ---------------- runner side (token auth) ----------------

/** Runners subscribe to this for work assigned to them. */
export const queuedFor = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const runner = await runnerForToken(ctx, token);
    return ctx.db.query("runs").withIndex("by_runner_state", (q) => q.eq("runnerId", runner._id).eq("state", "queued")).collect();
  },
});

/** Everything a runner needs to host one run: the chat, the agent, the prompt, and recent context. */
export const detail = query({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const { run } = await ownRun(ctx, token, runId);
    const chat = (await ctx.db.get(run.chatId))!;
    const agent = (await ctx.db.get(run.agentId))!;
    const dispatch = (await ctx.db.get(run.dispatchMessageId))!;
    const all = await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", run.chatId)).collect();
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", run.chatId)).collect();
    const previous = runs.filter((r) => r._id !== runId && r.agentId === run.agentId && r.endedAt).sort((a, b) => b.endedAt! - a.endedAt!)[0] ?? null;
    // Context policy "since-landing-plus-summary": messages after the last landing, before this dispatch.
    const since = previous?.endedAt ?? 0;
    const transcript = all.filter((m) => m._creationTime > since && m._creationTime < dispatch._creationTime && m.kind !== "steer").slice(-40);
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    return { run, chat, agent, dispatch, transcript, previous, agents: agents.map((a) => ({ id: a._id, handle: a.handle, harness: a.harness })) };
  },
});

/** The runner has a worktree and is about to start the harness. First claim also fixes the chat's branch. */
export const claim = mutation({
  args: { token: v.string(), runId: v.id("runs"), branch: v.union(v.string(), v.null()), worktree: v.string() },
  handler: async (ctx, { token, runId, branch, worktree }) => {
    const { run } = await ownRun(ctx, token, runId);
    await ctx.db.patch(runId, { state: "working", branch, worktree, startedAt: Date.now() });
    const chat = (await ctx.db.get(run.chatId))!;
    if (branch && !chat.activeBranch) await ctx.db.patch(chat._id, { activeBranch: branch });
  },
});

/** Coalesced on the runner side. Seq is assigned here so user-side events (approvals) interleave safely. */
export const appendEvents = mutation({
  args: { token: v.string(), runId: v.id("runs"), events: v.array(v.any()) },
  handler: async (ctx, { token, runId, events }) => {
    await ownRun(ctx, token, runId);
    await insertEvents(ctx, runId, events);
  },
});

async function insertEvents(ctx: MutationCtx, runId: Id<"runs">, events: unknown[]) {
  const last = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).order("desc").first();
  let seq = (last?.seq ?? -1) + 1;
  for (const event of events) await ctx.db.insert("runEvents", { runId, seq: seq++, event });
}

/** The agent speaks. One message per turn, streamed by patching. */
export const say = mutation({
  args: { token: v.string(), runId: v.id("runs"), turn: v.number(), text: v.string() },
  handler: async (ctx, { token, runId, turn, text }) => {
    const { run } = await ownRun(ctx, token, runId);
    await ctx.db.patch(run.chatId, { lastMessageAt: Date.now() });
    return ctx.db.insert("messages", { chatId: run.chatId, author: `agent:${run.agentId}`, kind: "report", text, runId, turn, reactions: [] });
  },
});

export const patchSay = mutation({
  args: { token: v.string(), messageId: v.id("messages"), text: v.string() },
  handler: async (ctx, { token, messageId, text }) => {
    const m = await ctx.db.get(messageId);
    if (!m || !m.runId) throw new Error("no such agent message");
    await ownRun(ctx, token, m.runId);
    await ctx.db.patch(messageId, { text });
  },
});

/** What the runner watches while a run is live: steers, approval decisions, and stop requests. */
export const control = query({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const { run } = await ownRun(ctx, token, runId);
    const msgs = await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", run.chatId)).collect();
    const steers = msgs.filter((m) => m.runId === runId && m.kind === "steer").map((m) => ({ id: m._id, author: m.author, text: m.text }));
    const events = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    const resolutions = events.map((e) => e.event as { type: string; requestId?: string; by?: string; decision?: string })
      .filter((e) => e.type === "request.resolved").map((e) => ({ requestId: e.requestId!, by: e.by!, decision: e.decision! }));
    return { state: run.state, interruptRequestedAt: run.interruptRequestedAt ?? null, steers, resolutions };
  },
});

/** Beam's attach_repo tool. The agent may attach any repo in the workspace, or add a new one by name. */
export const attachRepo = mutation({
  args: { token: v.string(), runId: v.id("runs"), repo: v.string() },
  handler: async (ctx, { token, runId, repo }) => {
    const { run } = await ownRun(ctx, token, runId);
    const chat = (await ctx.db.get(run.chatId))!;
    const name = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`"${repo}" is not owner/name`);
    if (chat.activeBranch && chat.repo !== name) throw new Error(`this chat already has a branch on ${chat.repo}`);
    const ws = (await ctx.db.get(chat.workspaceId))!;
    if (!ws.repos.includes(name)) await ctx.db.patch(ws._id, { repos: [...ws.repos, name] });
    await ctx.db.patch(chat._id, { repo: name });
    return { repo: name, added: !ws.repos.includes(name) };
  },
});

export const workspaceRepos = query({
  args: { token: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, runId }) => {
    const { run } = await ownRun(ctx, token, runId);
    const chat = (await ctx.db.get(run.chatId))!;
    const ws = (await ctx.db.get(chat.workspaceId))!;
    return { repos: ws.repos, attached: chat.repo };
  },
});

export const land = mutation({
  args: { token: v.string(), runId: v.id("runs"), state: v.string(), landing: v.any(), resumeCursor: v.any() },
  handler: async (ctx, { token, runId, state, landing, resumeCursor }) => {
    await ownRun(ctx, token, runId);
    await ctx.db.patch(runId, { state, landing, resumeCursor, endedAt: Date.now() });
  },
});

// ---------------- member side (Convex Auth) ----------------

export const forChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    await requireChat(ctx, chatId);
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    const out = [];
    for (const r of runs) {
      const runner = await ctx.db.get(r.runnerId);
      out.push({ ...r, runnerName: runner?.name ?? "runner" });
    }
    return out;
  },
});

/** Every event for every run in a chat. Deltas are never stored, so this stays small. */
export const eventsForChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    await requireChat(ctx, chatId);
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    const out: Record<string, unknown[]> = {};
    for (const r of runs) {
      const rows = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", r._id)).collect();
      out[r._id] = rows.map((x) => x.event);
    }
    return out;
  },
});

/** Anyone in the chat can answer an agent's question. The decision is an event so the runner sees it live. */
export const respond = mutation({
  args: { runId: v.id("runs"), requestId: v.string(), decision: v.string() },
  handler: async (ctx, { runId, requestId, decision }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("no such run");
    const { u } = await requireChat(ctx, run.chatId);
    const events = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    const already = events.some((e) => { const ev = e.event as { type: string; requestId?: string }; return ev.type === "request.resolved" && ev.requestId === requestId; });
    if (already) return;
    await insertEvents(ctx, runId, [{ type: "request.resolved", runId, requestId, by: u.githubLogin!, decision }]);
  },
});

export const interrupt = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("no such run");
    await requireChat(ctx, run.chatId);
    if (isLive(run.state)) await ctx.db.patch(runId, { interruptRequestedAt: Date.now() });
  },
});

/**
 * Pick where a dispatch runs: the chat's pinned runner if it is up, else the dispatcher's own runner,
 * else any workspace member's online runner that has the harness signed in (so someone on the web
 * with no machine of their own can still put an agent to work; the runner's owner pays).
 */
export async function chooseRunner(ctx: QueryCtx | MutationCtx, chat: Doc<"chats">, login: string, harness: string) {
  const fresh = (r: Doc<"runners">) => r.online && r.lastSeen > Date.now() - 90_000;
  const ready = (r: Doc<"runners">) => (r.harnesses as { harness: string; auth: string }[] | null)?.some((h) => h.harness === harness && h.auth === "authenticated") ?? false;
  const best = (rs: Doc<"runners">[]) => rs.filter(fresh).filter(ready).sort((a, b) => Number(b.launchedByApp) - Number(a.launchedByApp))[0] ?? null;
  if (chat.pinnedRunner) {
    const r = await ctx.db.get(chat.pinnedRunner);
    if (r && fresh(r) && ready(r)) return r;
  }
  const mine = await ctx.db.query("runners").withIndex("by_owner", (q) => q.eq("ownerLogin", login)).collect();
  const own = best(mine);
  if (own) return own;
  const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
  for (const m of members) {
    if (m.githubLogin === login) continue;
    const r = best(await ctx.db.query("runners").withIndex("by_owner", (q) => q.eq("ownerLogin", m.githubLogin)).collect());
    if (r) return r;
  }
  if (mine.some(fresh)) throw new Error(`Your runner is up but ${harness} is not signed in there. Check Settings → Connected harnesses.`);
  throw new Error("No runner online in this workspace. Open the Beam app on a machine, or run `beam-runner start`.");
}
