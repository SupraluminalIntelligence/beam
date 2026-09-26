import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * A reviewer account for App Store and TestFlight review. One fixed user with its own workspace, reached only
 * through the "demo" credentials provider, whose email and password live in the DEMO_EMAIL and DEMO_PASSWORD
 * environment variables. Nothing here touches anyone else's data.
 */
export const DEMO_LOGIN = "beam-demo";

/** Constant-time comparison so a wrong guess takes as long as a near miss. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Off unless both variables are set; the email is case-insensitive, the password is not. */
export function demoMatches(email: unknown, password: unknown, env: { DEMO_EMAIL?: string; DEMO_PASSWORD?: string }) {
  if (!env.DEMO_EMAIL || !env.DEMO_PASSWORD || typeof email !== "string" || typeof password !== "string") return false;
  return same(email.trim().toLowerCase(), env.DEMO_EMAIL.trim().toLowerCase()) && same(password, env.DEMO_PASSWORD);
}

const min = 60_000;

/** The demo user, and on first sign-in a small workspace that shows what Beam does. Idempotent. */
export const ensure = internalMutation({
  args: {},
  handler: async (ctx) => {
    let user = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", DEMO_LOGIN)).first();
    const userId = user?._id ?? await ctx.db.insert("users", { name: "Beam Demo", githubLogin: DEMO_LOGIN, username: "demo" });
    user = user ?? (await ctx.db.get(userId))!;
    const already = await ctx.db.query("members").withIndex("by_login", (q) => q.eq("githubLogin", DEMO_LOGIN)).first();
    if (!already) await seed(ctx, userId);
    return { userId };
  },
});

async function seed(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  const repo = "beam-demo/tracker";
  const workspaceId = await ctx.db.insert("workspaces", { name: "Beam Demo", repos: [repo], createdBy: userId });
  for (const [login, name] of [[DEMO_LOGIN, null], ["demo-maya", "Maya (demo)"], ["demo-sam", "Sam (demo)"]] as const) {
    await ctx.db.insert("members", { workspaceId, githubLogin: login, invitedBy: userId });
    if (name && !(await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", login)).first())) await ctx.db.insert("users", { name, githubLogin: login });
  }
  const agent = (harness: string, handle: string, model: string, effort: string, permissionMode: string) =>
    ctx.db.insert("agents", { workspaceId, harness, handle, model, effort, permissionMode, alwaysAllow: [], contextPolicy: "since-landing-plus-summary" });
  const claude = await agent("claude", "claude", "Fable 5.1", "high", "ask");
  const codex = await agent("codex", "codex", "GPT-6 Astra", "medium", "auto");
  // An offline machine with a revoked token: runs need one, nothing can connect as it.
  const tokenId = await ctx.db.insert("runnerTokens", { tokenHash: `demo-revoked-${now}`, githubLogin: DEMO_LOGIN, name: "demo-mac", createdAt: now, revokedAt: now });
  const runnerId = await ctx.db.insert("runners", { tokenId, ownerLogin: DEMO_LOGIN, name: "demo-mac", hostname: "demo-mac", platform: "darwin", online: false, lastSeen: now - 30 * min, harnesses: [], probeRequestedAt: 0, launchedByApp: true });
  const chat = (title: string, at: number) => ctx.db.insert("chats", { workspaceId, title, untitled: false, private: false, members: [DEMO_LOGIN, "demo-maya", "demo-sam"], agents: null, pinnedAgent: null, pinnedRunner: null, repo, activeBranch: null, repos: [repo], state: "open", createdBy: DEMO_LOGIN, lastMessageAt: at });
  const say = (chatId: Id<"chats">, author: string, text: string, _at: number, extra: Partial<{ kind: string; runId: Id<"runs">; turn: number; reactions: { emoji: string; by: string[] }[] }> = {}) =>
    ctx.db.insert("messages", { chatId, author, kind: extra.kind ?? "text", text, runId: extra.runId ?? null, reactions: extra.reactions ?? [], ...(extra.turn ? { turn: extra.turn } : {}) });

  /**
   * A finished run. Messages are stamped when written, so the run's steps are timed between the dispatch and
   * the reply as stored, which keeps the timeline in conversational order.
   */
  async function run(chatId: Id<"chats">, agentId: Id<"agents">, model: string, effort: string, dispatch: Id<"messages">, steps: [string, string, number][], reply: string, landing: unknown, branch: string | null) {
    const runId = await ctx.db.insert("runs", { chatId, agentId, runnerId, dispatchedBy: DEMO_LOGIN, dispatchMessageId: dispatch, state: "landed", branch, worktree: null, resumeCursor: null, landing, startedAt: null, endedAt: null,
      execution: { model, modelName: model, effort, accountOwner: DEMO_LOGIN, accountEmail: null, accountPlan: null, machineName: "demo-mac" } });
    const replyId = await say(chatId, `agent:${agentId}`, reply, 0, { kind: "report", runId, turn: 1 });
    const from = (await ctx.db.get(dispatch))!._creationTime, to = (await ctx.db.get(replyId))!._creationTime;
    const slots = steps.length * 2 + 2, at = (i: number) => from + ((to - from) * (i + 1)) / (slots + 2);
    const events: Record<string, unknown>[] = [{ type: "turn.started", runId, turnId: "t1", at: at(0) }];
    steps.forEach(([kind, summary, ms], i) => {
      events.push({ type: "item.started", runId, itemId: `i${i}`, kind, summary, at: at(1 + i * 2) });
      events.push({ type: "item.completed", runId, itemId: `i${i}`, summary, detail: null, ok: true, ms, at: at(2 + i * 2) });
    });
    events.push({ type: "message.started", runId, messageId: replyId, at: at(slots - 1) });
    events.push({ type: "turn.completed", runId, turnId: "t1", at: at(slots) });
    for (const [seq, event] of events.entries()) await ctx.db.insert("runEvents", { runId, seq, event });
    await ctx.db.patch(runId, { startedAt: from, endedAt: to });
    return runId;
  }

  const tracker = await chat("Tracker: run history per experiment", now - 18 * min);
  await say(tracker, "demo-maya", "Can the tracker show run history per experiment? Newest first, with the seed and the commit.", now - 40 * min);
  const d1 = await say(tracker, DEMO_LOGIN, "@claude let's do it. One table under each experiment, nothing fancy.", now - 38 * min, { kind: "dispatch" });
  await run(tracker, claude, "Fable 5.1", "high", d1,
    [["read", "Read src/app/tracker/page.tsx", 300], ["search", "Grep experimentRuns in src", 200], ["write", "Write src/app/tracker/RunHistory.tsx", 1900], ["edit", "Edit src/app/tracker/page.tsx", 1100], ["bash", "pnpm test", 6200]],
    "Run history is now a table under each experiment, newest first, with the seed, the commit and how long it took. Tests pass.",
    { repos: [{ repo, branch: "tracker/run-history", base: "main", pushed: true, add: 112, del: 9, files: 3, prUrl: null, compareUrl: null, error: null }], error: null }, "tracker/run-history");
  await ctx.db.insert("changes", { chatId: tracker, workspaceId, repo, branch: "tracker/run-history", base: "main", state: "open", title: "Run history per experiment", prUrl: null, prNumber: 12, add: 112, del: 9, files: 3, adopted: false, createdBy: DEMO_LOGIN, updatedAt: now - 20 * min, resolvedAt: null });
  await say(tracker, "demo-maya", "Perfect 🙏", now - 18 * min, { reactions: [{ emoji: "🎉", by: [DEMO_LOGIN] }] });

  const copy = await chat("Empty-state copy", now - 6 * min);
  await say(copy, "demo-sam", "The empty state just says \"No workspaces yet.\" Can it tell people what to do next?", now - 12 * min);
  const d2 = await say(copy, DEMO_LOGIN, "@codex draft three short options, no code yet.", now - 11 * min, { kind: "dispatch" });
  await run(copy, codex, "GPT-6 Astra", "medium", d2, [["read", "Read src/components/Empty.tsx", 250]],
    "Three options:\n\n1. **No workspaces yet.** Create one on your Mac, or ask a teammate to invite your GitHub login.\n2. **Nothing here yet.** Workspaces you create or join show up here.\n3. **Start on your Mac.** Make a workspace there and it appears on your phone.",
    { repos: [], error: null }, null);
  await say(copy, "demo-sam", "Option 1 reads best to me.", now - 6 * min, { reactions: [{ emoji: "👍", by: [DEMO_LOGIN] }] });
}

/** Rebuild the demo workspace from scratch. Deletes only rows inside workspaces the demo user belongs to, plus its machine. */
export const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", DEMO_LOGIN)).first();
    if (!user) return { removed: 0 };
    let removed = 0;
    const del = async (id: Parameters<typeof ctx.db.delete>[0]) => { await ctx.db.delete(id); removed++; };
    for (const m of await ctx.db.query("members").withIndex("by_login", (q) => q.eq("githubLogin", DEMO_LOGIN)).collect()) {
      const ws = await ctx.db.get(m.workspaceId);
      if (!ws || ws.createdBy !== user._id) continue; // never touch a workspace the demo user did not create
      for (const chat of await ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id)).collect()) {
        for (const run of await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect()) {
          for (const e of await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", run._id)).collect()) await del(e._id);
          await del(run._id);
        }
        for (const x of await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect()) await del(x._id);
        for (const x of await ctx.db.query("changes").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect()) await del(x._id);
        await del(chat._id);
      }
      for (const x of await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id)).collect()) await del(x._id);
      for (const x of await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id)).collect()) await del(x._id);
      await del(ws._id);
    }
    for (const r of await ctx.db.query("runners").withIndex("by_owner", (q) => q.eq("ownerLogin", DEMO_LOGIN)).collect()) { await del(r._id); await del(r.tokenId); }
    await seed(ctx, user._id);
    return { removed };
  },
});
