import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { autoTitle, requireChat } from "./lib";
import { resolveExecution } from "../packages/contracts/src/execution";
import { selectionKey } from "./connections";
import { followParticipant, notifyMentions } from "./notifications";
import { chooseRunner, isLive } from "./runs";

export const list = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    await requireChat(ctx, chatId);
    return ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
  },
});

/** Create a run for a dispatch. Throws when nobody can host it. */
export async function startRun(ctx: MutationCtx, chat: Doc<"chats">, agent: Doc<"agents">, messageId: Id<"messages">, login: string, localRunnerId?: Id<"runners">, expectedConnection?: string) {
  if (chat.state === "deleted") throw new Error("This chat has been deleted.");
  const dispatch = await ctx.db.get(messageId);
  const runner = await chooseRunner(ctx, chat, login, agent.harness, localRunnerId ?? dispatch?.localRunnerId);
  if (expectedConnection && selectionKey(runner._id, runner.connection) !== expectedConnection) throw new Error("The selected connection changed. Review the account and send again.");
  const user = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", login)).first();
  const execution = { ...resolveExecution(agent, user?.agentPreferences ?? [], runner), connectionId: runner.connection?.connectionId ?? "default", connectionName: runner.connection?.connectionName ?? "Default account", machineName: runner.name, ...(runner.connection?.accountIdentity ? { accountIdentity: runner.connection.accountIdentity } : {}) };
  const studyId = dispatch?.studyContext === undefined ? chat.activeStudyId ?? null : dispatch.studyContext?.id ?? null;
  const runId = await ctx.db.insert("runs", {
    studyId,
    workScope: `${runner._id}-${agent._id}-${login}`,
    execution,
    chatId: chat._id, agentId: agent._id, runnerId: runner._id, dispatchedBy: login, dispatchMessageId: messageId, state: "queued",
    branch: chat.activeBranch, worktree: null, resumeCursor: null, landing: null, startedAt: null, endedAt: null,
  });
  await followParticipant(ctx, chat._id, login);
  await ctx.db.patch(messageId, { runId });
  return { runId, runnerName: runner.name };
}

/** Kind is decided here from chat state: plain text, a dispatch, or a steer of the live run. */
export const send = mutation({
  args: { chatId: v.id("chats"), text: v.string(), mentionHandle: v.union(v.string(), v.null()), localRunnerId: v.optional(v.id("runners")), expectedConnection: v.optional(v.string()), targetRunId: v.optional(v.id("runs")), attachments: v.optional(v.array(v.id("files"))) },
  handler: async (ctx, { chatId, text, mentionHandle, localRunnerId, expectedConnection, targetRunId, attachments = [] }) => {
    const { chat, u } = await requireChat(ctx, chatId);
    const body = text.trim();
    if (!body && !attachments.length) throw new Error("empty");
    if (attachments.length > 10 || new Set(attachments).size !== attachments.length) throw new Error("Maximum 10 files per message");
    for (const id of attachments) {
      const f = await ctx.db.get(id);
      if (!f || f.chatId !== chatId || f.author !== u.githubLogin || f.messageId) throw new Error("Invalid attachment");
    }
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    let target: typeof agents[number] | null = null;
    if (mentionHandle) {
      const a = agents.find((x) => x.handle === mentionHandle);
      if (!a) throw new Error(`no agent @${mentionHandle} in this workspace`);
      if (chat.agents && !chat.agents.includes(a._id)) throw new Error(`@${mentionHandle} is not in this chat`);
      target = a;
    } else if (chat.private && chat.pinnedAgent) target = agents.find((x) => x._id === chat.pinnedAgent) ?? null;
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect();
    const explicitRun = targetRunId ? runs.find(r => r._id === targetRunId && isLive(r.state)) : null;
    if (targetRunId && !explicitRun) throw new Error("This run has ended. Choose an agent for a new run.");
    if (explicitRun) {
      if (target && target._id !== explicitRun.agentId) throw new Error("The selected run belongs to a different agent.");
      target = agents.find(a => a._id === explicitRun.agentId) ?? null;
      if (!target) throw new Error("Agent no longer available");
    }
    const live = explicitRun ?? (target ? runs.find(r => isLive(r.state) && r.agentId === target!._id && r.dispatchedBy === u.githubLogin) : null);
    const kind = target ? (live ? "steer" : "dispatch") : "text";
    // Fail before writing anything if a dispatch has nowhere to run.
    if (kind === "dispatch") await chooseRunner(ctx, chat, u.githubLogin!, target!.harness, localRunnerId);
    const patch: Record<string, unknown> = { lastMessageAt: Date.now() };
    if (chat.untitled) Object.assign(patch, { untitled: false, title: autoTitle(body || "Attached files") });
    if (chat.state && chat.state !== "open") patch["state"] = "open"; // a message reopens a done or settled thread
    await ctx.db.patch(chatId, patch);
    const study = chat.activeStudyId ? await ctx.db.get(chat.activeStudyId) : null;
    const studyContext = study?.chatId === chatId ? {id:study._id,revision:study.revision,name:study.name} : null;
    const id = await ctx.db.insert("messages", { ...(localRunnerId ? { localRunnerId } : {}), studyContext, chatId, author: u.githubLogin!, kind, text: body, runId: live?._id ?? null, reactions: [], attachments });
    for (const fileId of attachments) await ctx.db.patch(fileId, { messageId: id });
    await followParticipant(ctx, chatId, u.githubLogin!);
    await notifyMentions(ctx, id);
    let runner: string | null = null;
    if (kind === "dispatch") runner = (await startRun(ctx, chat, target!, id, u.githubLogin!, localRunnerId, expectedConnection)).runnerName;
    // Plain messages in a team chat with agents go to the router: it decides whether an agent should act.
    const listening = (chat.autoRoute ?? true) && !chat.private && (chat.agents ? chat.agents.length > 0 : agents.length > 0);
    if (kind === "text" && !target && !mentionHandle && listening) await ctx.scheduler.runAfter(0, internal.router.classify, { messageId: id });
    return { id, kind, runner };
  },
});

export const react = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, { messageId, emoji }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return;
    const { u } = await requireChat(ctx, m.chatId);
    const login = u.githubLogin!;
    const rx = m.reactions.map((r) => ({ emoji: r.emoji, by: [...r.by] }));
    const r = rx.find((x) => x.emoji === emoji);
    if (!r) rx.push({ emoji, by: [login] });
    else if (r.by.includes(login)) r.by = r.by.filter((b) => b !== login);
    else r.by.push(login);
    await ctx.db.patch(messageId, { reactions: rx.filter((x) => x.by.length) });
  },
});
