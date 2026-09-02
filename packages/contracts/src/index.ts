import { z } from "zod";

// ---- ids ----
const id = (name: string) => z.string().min(1).brand(name);
export const WorkspaceId = id("WorkspaceId");
export const ChatId = id("ChatId");
export const MessageId = id("MessageId");
export const RunId = id("RunId");
export const RunnerId = id("RunnerId");
export const UserId = id("UserId");
export const AgentId = id("AgentId");

// ---- harness / agent ----
export const HarnessKind = z.enum(["claude", "codex", "omp"]);
export type HarnessKind = z.infer<typeof HarnessKind>;

export const Effort = z.enum(["low", "medium", "high", "max"]);
/** ask = approve each risky call in the chat · plan = read-only until the plan is approved · auto = the harness's own auto-approval · allowlist = only alwaysAllow plus edits */
export const PermissionMode = z.enum(["ask", "plan", "auto", "allowlist"]);
export const ContextPolicy = z.enum(["last-landing", "since-landing-plus-summary", "whole-chat"]);

/** A workspace-level agent: a harness plus its settings. Nobody owns it. */
export const Agent = z.object({
  id: AgentId,
  workspaceId: WorkspaceId,
  harness: HarnessKind,
  handle: z.string().regex(/^[a-z0-9-]+$/),
  model: z.string(),
  effort: Effort,
  permissionMode: PermissionMode,
  alwaysAllow: z.array(z.string()),
  contextPolicy: ContextPolicy,
});
export type Agent = z.infer<typeof Agent>;

/** What a probe learned about a harness on one machine. Never contains a credential. */
export const HarnessStatus = z.object({
  harness: HarnessKind,
  installed: z.boolean(),
  version: z.string().nullable(),
  auth: z.enum(["authenticated", "unauthenticated", "unknown"]),
  plan: z.string().nullable(),
  email: z.string().nullable(),
  message: z.string().nullable(),
  probedAt: z.number(),
});
export type HarnessStatus = z.infer<typeof HarnessStatus>;

// ---- chat ----
export const Chat = z.object({
  id: ChatId,
  workspaceId: WorkspaceId,
  title: z.string(),
  untitled: z.boolean(),
  private: z.boolean(),
  members: z.array(UserId),
  agents: z.array(AgentId).nullable(), // null = every workspace agent
  pinnedAgent: AgentId.nullable(),      // private chats only
  pinnedRunner: RunnerId.nullable(),
  repo: z.string().nullable(),          // "owner/name"
  activeBranch: z.string().nullable(),
  createdAt: z.number(),
});
export type Chat = z.infer<typeof Chat>;

export const MessageKind = z.enum(["text", "dispatch", "steer", "ask", "report"]);
export const Message = z.object({
  id: MessageId,
  chatId: ChatId,
  author: z.union([UserId, AgentId]),
  kind: MessageKind,
  text: z.string(),
  runId: RunId.nullable(),
  turn: z.number().optional(),
  reactions: z.array(z.object({ emoji: z.string(), by: z.array(UserId) })),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

// ---- runs ----
export const RunState = z.enum(["queued", "starting", "working", "landing", "landed", "failed", "interrupted"]);
/** What a run leaves behind. The branch is always pushed, the PR is best effort. */
export const Landing = z.object({
  branch: z.string(),
  base: z.string(),
  pushed: z.boolean(),
  add: z.number(),
  del: z.number(),
  files: z.number(),
  prUrl: z.string().nullable(),
  compareUrl: z.string().nullable(),
  error: z.string().nullable(),
});
export type Landing = z.infer<typeof Landing>;

export const Run = z.object({
  id: RunId,
  chatId: ChatId,
  agentId: AgentId,
  runnerId: RunnerId,
  dispatchedBy: UserId,
  dispatchMessageId: MessageId,
  state: RunState,
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  resumeCursor: z.unknown().nullable(),
  landing: Landing.nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  interruptRequestedAt: z.number().optional(),
});
export type Run = z.infer<typeof Run>;

/** Normalized harness events. Every adapter emits only these. */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), runId: RunId, resumeCursor: z.unknown().nullable() }),
  z.object({ type: z.literal("turn.started"), runId: RunId, turnId: z.string() }),
  z.object({ type: z.literal("content.delta"), runId: RunId, messageId: MessageId, delta: z.string() }),
  z.object({ type: z.literal("content.final"), runId: RunId, messageId: MessageId, text: z.string() }),
  z.object({ type: z.literal("item.started"), runId: RunId, itemId: z.string(), kind: z.string(), summary: z.string() }),
  z.object({ type: z.literal("item.completed"), runId: RunId, itemId: z.string(), summary: z.string(), detail: z.string().nullable(), ok: z.boolean(), ms: z.number().nullable() }),
  z.object({ type: z.literal("request.opened"), runId: RunId, requestId: z.string(), kind: z.enum(["approval", "input"]), prompt: z.string(), options: z.array(z.string()).nullable() }),
  z.object({ type: z.literal("request.resolved"), runId: RunId, requestId: z.string(), by: UserId, decision: z.string() }),
  z.object({ type: z.literal("steer.received"), runId: RunId, messageId: MessageId }),
  z.object({ type: z.literal("turn.completed"), runId: RunId, turnId: z.string() }),
  z.object({ type: z.literal("account.updated"), runId: RunId, plan: z.string().nullable(), email: z.string().nullable() }),
  z.object({ type: z.literal("error"), runId: RunId, message: z.string(), fatal: z.boolean() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

/** Feature flags a client checks before using newer shapes. */
export const Capabilities = z.object({ contracts: z.literal(1), runners: z.literal(1) });
export const CONTRACTS_VERSION = 1 as const;
