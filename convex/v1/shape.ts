import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireChatLogin } from "../lib";
import { threadRepos } from "../changes";
import type * as L from "../../packages/contracts/src/layer";
import { PRIVATE_EVENT_TYPES } from "../../packages/contracts/src/layer";

/**
 * Database rows to the layer API's shapes (packages/contracts/src/layer.ts). This is where the contract is
 * kept: internal fields change freely, these outputs only grow. Anything private stops here: machine paths,
 * resume cursors, provider accounts, tokens.
 */

/** A chat a person can read. Deleted chats read as missing. */
export async function readableChat(ctx: QueryCtx, chatId: Id<"chats">, login: string) {
  const chat = await requireChatLogin(ctx, chatId, login);
  if (chat.state === "deleted") throw new Error("no such chat");
  return chat;
}

export async function person(ctx: QueryCtx, login: string): Promise<L.Person> {
  const u = await ctx.db.query("users").withIndex("by_login", (q) => q.eq("githubLogin", login)).first();
  return { login, name: u?.username ?? login, image: u?.image ?? null };
}

export const agent = (a: Doc<"agents">): L.Agent => ({ id: a._id, handle: a.handle, harness: a.harness, model: a.model, effort: a.effort, permissionMode: a.permissionMode });

export const chat = (c: Doc<"chats">): L.Chat => ({
  id: c._id, workspaceId: c.workspaceId, title: c.title, untitled: c.untitled, private: c.private, members: c.members,
  agents: c.agents, pinnedAgent: c.pinnedAgent, repos: threadRepos(c), state: c.state === "settled" ? "settled" : "open",
  createdBy: c.createdBy, createdAt: c._creationTime, lastMessageAt: c.lastMessageAt,
});

const author = (a: string): L.Author => a.startsWith("agent:") ? { type: "agent", agentId: a.slice(6) } : { type: "person", login: a };
export const message = (m: Doc<"messages">): L.Message => ({
  id: m._id, chatId: m.chatId, author: author(m.author), kind: m.kind as L.Message["kind"], text: m.text,
  runId: m.runId, turn: m.turn ?? null, reactions: m.reactions, attachments: m.attachments ?? [], createdAt: m._creationTime,
});

export async function run(ctx: QueryCtx, r: Doc<"runs">): Promise<L.Run> {
  const machine = r.execution?.machineName ?? (await ctx.db.get(r.runnerId))?.name ?? "runner";
  return {
    id: r._id, chatId: r.chatId, agentId: r.agentId, dispatchedBy: r.dispatchedBy, dispatchMessageId: r.dispatchMessageId,
    state: r.state as L.RunState, branch: r.branch, landing: r.landing ?? null,
    openRequests: r.openRequests ?? [], interruptRequested: !!r.interruptRequestedAt,
    machine, model: r.execution?.modelName ?? r.execution?.model ?? null, effort: r.execution?.effort ?? null,
    createdAt: r._creationTime, startedAt: r.startedAt, endedAt: r.endedAt,
  };
}

/** Account and usage events describe a person's provider plan; resume cursors are the harness's own. */
export function events(rows: readonly { event: unknown }[]): L.RunEvent[] {
  const out: L.RunEvent[] = [];
  for (const { event } of rows) {
    const e = event as L.RunEvent;
    if (PRIVATE_EVENT_TYPES.includes(e.type)) continue;
    out.push(e.type === "session.started" ? { ...e, resumeCursor: null } : e);
  }
  return out;
}

export const change = (c: Doc<"changes">): L.Change => ({
  id: c._id, chatId: c.chatId, repo: c.repo, branch: c.branch, base: c.base, state: c.state as L.Change["state"], title: c.title,
  prUrl: c.prUrl, prNumber: c.prNumber, draft: c.draft ?? null, add: c.add, del: c.del, files: c.files, checks: c.checks ?? null,
  adopted: c.adopted, createdBy: c.createdBy, updatedAt: c.updatedAt, resolvedAt: c.resolvedAt,
});

export const notification = (n: Doc<"notifications">): L.Notification => ({
  id: n._id, chatId: n.chatId, workspaceId: n.workspaceId, runId: n.runId ?? null, messageId: n.messageId ?? null,
  kind: n.kind, title: n.title, body: n.body, read: n.readAt !== null, createdAt: n._creationTime,
});
