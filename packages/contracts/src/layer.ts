/**
 * The layer API, version 1: what an interaction layer can read from Beam.
 *
 * Every shape here is a promise to code outside this repo. Fields and enum values may be
 * added; nothing is renamed or removed. A breaking change is a new version beside this one.
 * Clients must ignore fields and values they do not know, so these schemas describe the
 * server's output and back its tests, and the SDK does not reject responses with them.
 */
import { z } from "zod";
import { Landing, type RunEvent as InternalRunEvent } from "./index.ts";

export const API_VERSION = 1 as const;

/** What a layer token may do. Only reads exist so far; writes arrive as their own scopes. */
export const Scope = z.enum(["read"]);
export type Scope = z.infer<typeof Scope>;

export const Person = z.object({ login: z.string(), name: z.string(), image: z.string().nullable() });
export type Person = z.infer<typeof Person>;

export const Me = Person.extend({ layer: z.object({ name: z.string(), scopes: z.array(Scope) }) });
export type Me = z.infer<typeof Me>;

export const Agent = z.object({
  id: z.string(), handle: z.string(), harness: z.string(), model: z.string(), effort: z.string(), permissionMode: z.string(),
});
export type Agent = z.infer<typeof Agent>;

export const Workspace = z.object({ id: z.string(), name: z.string(), repos: z.array(z.string()) });
export type Workspace = z.infer<typeof Workspace>;
export const WorkspaceDetail = Workspace.extend({ members: z.array(Person), agents: z.array(Agent) });
export type WorkspaceDetail = z.infer<typeof WorkspaceDetail>;

export const ChatState = z.enum(["open", "settled"]);
export const Chat = z.object({
  id: z.string(), workspaceId: z.string(), title: z.string(), untitled: z.boolean(), private: z.boolean(),
  members: z.array(z.string()),               // logins; a team chat is readable by the whole workspace regardless
  agents: z.array(z.string()).nullable(),     // null: every workspace agent may join
  pinnedAgent: z.string().nullable(),         // private chats answer to this agent without a mention
  repos: z.array(z.string()), state: ChatState,
  createdBy: z.string(), createdAt: z.number(), lastMessageAt: z.number(),
});
export type Chat = z.infer<typeof Chat>;

/** Most urgent first: an agent waiting on someone, work in progress, then unread outcomes. Idle chats are absent. */
export const ChatActivity = z.enum(["ask", "work", "bad", "done", "new"]);
export type ChatActivity = z.infer<typeof ChatActivity>;
export const Activity = z.record(z.string(), ChatActivity);

export const Author = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), login: z.string() }),
  z.object({ type: z.literal("agent"), agentId: z.string() }),
]);
export type Author = z.infer<typeof Author>;

/** text: people talking · dispatch: starts a run · steer: joins a live run · report: an agent's reply (its text grows while the run streams) */
export const MessageKind = z.enum(["text", "dispatch", "steer", "ask", "report"]);
export const Message = z.object({
  id: z.string(), chatId: z.string(), author: Author, kind: MessageKind, text: z.string(),
  runId: z.string().nullable(), turn: z.number().nullable(),
  reactions: z.array(z.object({ emoji: z.string(), by: z.array(z.string()) })),
  attachments: z.array(z.string()), createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

export const RunState = z.enum(["queued", "starting", "working", "landing", "landed", "failed", "interrupted"]);
export type RunState = z.infer<typeof RunState>;
export const LIVE_RUN_STATES: readonly RunState[] = ["queued", "starting", "working", "landing"];
export const Run = z.object({
  id: z.string(), chatId: z.string(), agentId: z.string(), dispatchedBy: z.string(), dispatchMessageId: z.string(),
  state: RunState, branch: z.string().nullable(), landing: Landing.nullable(),
  openRequests: z.array(z.string()),          // questions and approvals the agent is waiting on
  interruptRequested: z.boolean(),
  machine: z.string(), model: z.string().nullable(), effort: z.string().nullable(),
  createdAt: z.number(), startedAt: z.number().nullable(), endedAt: z.number().nullable(),
});
export type Run = z.infer<typeof Run>;
/** Every live run in a workspace, and each chat's most recent ended run per outcome. */
export const ActiveRuns = z.object({ live: z.array(Run), ended: z.array(Run) });
export type ActiveRuns = z.infer<typeof ActiveRuns>;

/**
 * A run's normalized events, as `packages/reducer` folds them. Account and usage events stay private.
 * Parsed loosely on purpose: a newer engine may add event types, and older layers skip them.
 */
export type RunEvent = Plain<Exclude<InternalRunEvent, { type: "account.updated" | "usage.updated" }>> & { at?: number };
/** Ids are plain strings outside Beam; the internal schemas brand them. */
type Unbrand<V> = V extends z.BRAND<string> ? string : V;
type Plain<T> = T extends unknown ? { [K in keyof T]: Unbrand<T[K]> } : never;
export const RunEventShape = z.object({ type: z.string(), runId: z.string(), at: z.number().optional() }).passthrough();
export const PRIVATE_EVENT_TYPES: readonly string[] = ["account.updated", "usage.updated"];

export const Checks = z.object({
  state: z.enum(["pending", "passing", "failing", "none"]), passed: z.number(), failed: z.number(), pending: z.number(), skipped: z.number(),
  items: z.array(z.object({ name: z.string(), state: z.enum(["passed", "failed", "pending", "skipped"]), url: z.string().nullable() })),
  checkedAt: z.number(),
});
/** One branch in one repo, with its pull request once there is one. */
export const Change = z.object({
  id: z.string(), chatId: z.string(), repo: z.string(), branch: z.string(), base: z.string(),
  state: z.enum(["open", "merged", "closed"]), title: z.string(),
  prUrl: z.string().nullable(), prNumber: z.number().nullable(), draft: z.boolean().nullable(),
  add: z.number(), del: z.number(), files: z.number(), checks: Checks.nullable(),
  adopted: z.boolean(), createdBy: z.string(), updatedAt: z.number(), resolvedAt: z.number().nullable(),
});
export type Change = z.infer<typeof Change>;

/** The shared truth of where someone is: the one chat they have focused, or none. */
export const Presence = z.object({ login: z.string(), chatId: z.string().nullable() });
export type Presence = z.infer<typeof Presence>;
export const Typing = z.object({ login: z.string(), until: z.number() });

export const Notification = z.object({
  id: z.string(), chatId: z.string(), workspaceId: z.string(), runId: z.string().nullable(), messageId: z.string().nullable(),
  kind: z.enum(["completed", "failed", "input", "mention"]), title: z.string(), body: z.string(), read: z.boolean(), createdAt: z.number(),
});
export type Notification = z.infer<typeof Notification>;

/**
 * Every resource a layer can read. Each is a live query: fetch it once, or subscribe and get the whole
 * value again whenever it changes. `fn` is the Convex function; every call also carries the layer token.
 */
export const RESOURCES = {
  "me.get":             { fn: "v1/me:get",               args: [],              returns: Me,                              about: "Who this token acts for, and what it may do" },
  "workspaces.list":    { fn: "v1/workspaces:list",      args: [],              returns: z.array(Workspace),              about: "Workspaces you are a member of" },
  "workspaces.get":     { fn: "v1/workspaces:get",       args: ["workspaceId"], returns: WorkspaceDetail,                 about: "A workspace with its members and agents" },
  "chats.list":         { fn: "v1/chats:list",           args: ["workspaceId"], returns: z.array(Chat),                   about: "Chats you can see, most recent first" },
  "chats.get":          { fn: "v1/chats:get",            args: ["chatId"],      returns: Chat,                            about: "One chat" },
  "chats.activity":     { fn: "v1/chats:activity",       args: ["workspaceId"], returns: Activity,                        about: "Status per chat: ask, work, bad, done or new; idle chats are absent" },
  "messages.list":      { fn: "v1/messages:list",        args: ["chatId"],      returns: z.array(Message),                about: "Every message in a chat, oldest first; agent replies grow while they stream" },
  "runs.list":          { fn: "v1/runs:list",            args: ["chatId"],      returns: z.array(Run),                    about: "Every agent run in a chat" },
  "runs.active":        { fn: "v1/runs:active",          args: ["workspaceId"], returns: ActiveRuns,                      about: "Live runs across a workspace, and the latest ended ones" },
  "runs.events":        { fn: "v1/runs:events",          args: ["runId"],       returns: z.array(RunEventShape),          about: "One run's events in order; fold them with the SDK's runView" },
  "runs.eventsForChat": { fn: "v1/runs:eventsForChat",   args: ["chatId"],      returns: z.record(z.string(), z.array(RunEventShape)), about: "Events for every run in a chat, keyed by run id" },
  "changes.list":       { fn: "v1/changes:list",         args: ["chatId"],      returns: z.array(Change),                 about: "Branches and pull requests a chat produced" },
  "people.presence":    { fn: "v1/people:presence",      args: ["workspaceId"], returns: z.array(Presence),               about: "Who is here in the last two minutes, and which chat each is in" },
  "people.typing":      { fn: "v1/people:typing",        args: ["chatId"],      returns: z.array(Typing),                 about: "Who is typing in a chat" },
  "inbox.list":         { fn: "v1/inbox:list",           args: [],              returns: z.array(Notification),           about: "Your latest notifications" },
} as const;
export type ResourceName = keyof typeof RESOURCES;
export type ResourceArgs<R extends ResourceName> = { [K in (typeof RESOURCES)[R]["args"][number]]: string };
export type ResourceValue<R extends ResourceName> = R extends "runs.events" ? RunEvent[] : R extends "runs.eventsForChat" ? Record<string, RunEvent[]> : z.infer<(typeof RESOURCES)[R]["returns"]>;

// ---- events a layer can react to, derived by diffing live resources ----

export const WorkspaceState = z.object({
  workspaceId: z.string(), chats: z.array(Chat), activity: Activity, presence: z.array(Presence), runs: ActiveRuns,
});
export type WorkspaceState = z.infer<typeof WorkspaceState>;
export const ChatSnapshot = z.object({
  chatId: z.string(), messages: z.array(Message), runs: z.array(Run), events: z.record(z.string(), z.array(RunEventShape)), changes: z.array(Change),
});
export type ChatSnapshot = Omit<z.infer<typeof ChatSnapshot>, "events"> & { events: Record<string, RunEvent[]> };

/**
 * Hints, not truth. A snapshot comes first; events describe what changed since the last one. After a
 * reconnect the next snapshot is the truth again, so a layer never has to replay anything.
 */
export type LayerEvent =
  | { type: "workspace.snapshot"; state: WorkspaceState }
  | { type: "chat.created"; chat: Chat }
  | { type: "chat.updated"; chat: Chat; previous: Chat }
  | { type: "chat.removed"; chatId: string }
  | { type: "chat.status"; chatId: string; status: ChatActivity | "idle"; previous: ChatActivity | "idle" }
  | { type: "person.arrived"; login: string; chatId: string | null }
  | { type: "person.moved"; login: string; chatId: string | null; previous: string | null }
  | { type: "person.left"; login: string; previous: string | null }
  | { type: "run.started"; run: Run }
  | { type: "run.changed"; run: Run; previous: RunState }
  | { type: "run.asking"; run: Run; requestIds: string[] }
  | { type: "run.answered"; run: Run; requestIds: string[] }
  | { type: "run.ended"; run: Run }
  | { type: "chat.snapshot"; snapshot: ChatSnapshot }
  | { type: "message.posted"; message: Message }
  | { type: "message.updated"; message: Message; previous: Message }
  | { type: "run.event"; runId: string; event: RunEvent }
  | { type: "change.opened"; change: Change }
  | { type: "change.updated"; change: Change; previous: Change };
export type LayerEventType = LayerEvent["type"];
