/**
 * The Beam Worlds API, version 1: what a world can read from Beam, and the few things it can do.
 *
 * Every shape here is a promise to code outside this repo. Fields and enum values may be
 * added; nothing is renamed or removed. A breaking change is a new version beside this one.
 * Clients must ignore fields and values they do not know, so these schemas describe the
 * server's output and back its tests, and the SDK does not reject responses with them.
 */
import { z } from "zod";
import { Landing, type RunEvent as InternalRunEvent } from "./index.ts";

export const API_VERSION = 1 as const;

/**
 * What an app token may do. Reads are free, writes are few: each write is its own scope, and together they
 * are never more than a person can do in the plain apps. Settings, invites, agents and machines stay app-only.
 */
export const Scope = z.enum(["read", "chat:write", "run:respond", "run:interrupt", "presence:write", "world:state"]);
export type Scope = z.infer<typeof Scope>;
/** Shown to the person before they approve, so the words are the permission. */
export const SCOPES: Record<Scope, string> = {
  "read": "See everything you can see in Beam: workspaces, chats (including private chats you are in), messages, agent runs, pull requests, who is where, and your notifications.",
  "chat:write": "Send messages and reactions as you, including @mentions that start agents on your machines and accounts.",
  "run:respond": "Answer agents' questions and approve or deny what they ask to do, as you.",
  "run:interrupt": "Stop agents that are running.",
  "presence:write": "Set which chat you are in.",
  "world:state": "Save its own state in your workspaces, such as where you stand in its world. Beam itself never reads it.",
};

export const Person = z.object({ login: z.string(), name: z.string(), image: z.string().nullable() });
export type Person = z.infer<typeof Person>;

export const Me = Person.extend({ app: z.object({ name: z.string(), scopes: z.array(Scope) }) });
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
 * Parsed loosely on purpose: a newer engine may add event types, and older worlds skip them.
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
export const Presence = z.object({
  login: z.string(), chatId: z.string().nullable(),
  world: z.string().nullable(),               // the interface they focused from; null for the plain apps
});
export type Presence = z.infer<typeof Presence>;
export const Typing = z.object({ login: z.string(), until: z.number() });

export const Notification = z.object({
  id: z.string(), chatId: z.string(), workspaceId: z.string(), runId: z.string().nullable(), messageId: z.string().nullable(),
  kind: z.enum(["completed", "failed", "input", "mention"]), title: z.string(), body: z.string(), read: z.boolean(), createdAt: z.number(),
});
export type Notification = z.infer<typeof Notification>;

/** A world's own state in a workspace: one entry per person, per chat, and one for the workspace. Free-form, at most 4 KB each. */
export const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WORLD_STATE_MAX_BYTES = 4096;
export const StateScope = z.enum(["person", "chat", "workspace"]);
export type StateScope = z.infer<typeof StateScope>;
export const WorldState = z.object({
  world: z.string(),
  people: z.array(z.object({ login: z.string(), data: z.unknown(), updatedAt: z.number() })),
  chats: z.array(z.object({ chatId: z.string(), data: z.unknown(), updatedBy: z.string(), updatedAt: z.number() })),
  workspace: z.object({ data: z.unknown(), updatedBy: z.string(), updatedAt: z.number() }).nullable(),
});
export type WorldState = z.infer<typeof WorldState>;

/**
 * Every resource a world can read. Each is a live query: fetch it once, or subscribe and get the whole
 * value again whenever it changes. `fn` is the Convex function; every call also carries the app token.
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
  "worlds.state":       { fn: "v1/worlds:state",         args: ["workspaceId", "world"], returns: WorldState,             about: "A world's own state in a workspace: per person, per chat, and shared" },
} as const;
export type ResourceName = keyof typeof RESOURCES;
export type ResourceArgs<R extends ResourceName> = { [K in (typeof RESOURCES)[R]["args"][number]]: string };
export type ResourceValue<R extends ResourceName> = R extends "runs.events" ? RunEvent[] : R extends "runs.eventsForChat" ? Record<string, RunEvent[]> : z.infer<(typeof RESOURCES)[R]["returns"]>;

/**
 * Everything a world can do. Argument kinds: `id` and `text` are strings, `json` is any JSON value, and a
 * trailing `?` makes it optional. Each needs its scope on the token.
 */
export const ACTIONS = {
  "messages.send":  { fn: "v1/messages:send",   scope: "chat:write",     args: { chatId: "id", text: "text", mention: "text?", runId: "id?" }, about: "Post as you. The first @handle of an agent in the chat starts it (or joins its live run); `mention` picks one explicitly, `runId` steers that run" },
  "messages.react": { fn: "v1/messages:react",  scope: "chat:write",     args: { messageId: "id", emoji: "text" },                       about: "Toggle your reaction on a message" },
  "runs.respond":   { fn: "v1/runs:respond",    scope: "run:respond",    args: { runId: "id", requestId: "id", decision: "text" },        about: "Answer an agent's open question or approval; the first answer wins" },
  "runs.interrupt": { fn: "v1/runs:interrupt",  scope: "run:interrupt",  args: { runId: "id" },                                          about: "Ask a live run to stop; its work is still pushed" },
  "people.focus":   { fn: "v1/people:focus",    scope: "presence:write", args: { workspaceId: "id", chatId: "id?", world: "text?" },       about: "Say which chat you are in (none without chatId), and from which world" },
  "worlds.set":     { fn: "v1/worlds:set",      scope: "world:state",    args: { workspaceId: "id", world: "text", scope: "text", chatId: "id?", data: "json" }, about: "Save this world's state for you (scope person), a chat, or the workspace; data null removes it" },
} as const;
export type ActionName = keyof typeof ACTIONS;
type ArgKind<K> = K extends "json" | "json?" ? unknown : string;
type Required<A> = { [K in keyof A as A[K] extends `${string}?` ? never : K]: ArgKind<A[K]> };
type Optional<A> = { [K in keyof A as A[K] extends `${string}?` ? K : never]?: ArgKind<A[K]> | null };
export type ActionArgs<N extends ActionName> = Required<(typeof ACTIONS)[N]["args"]> & Optional<(typeof ACTIONS)[N]["args"]>;
export const SendResult = z.object({ id: z.string(), kind: MessageKind, runner: z.string().nullable() });
export type ActionResult<N extends ActionName> = N extends "messages.send" ? z.infer<typeof SendResult> : null;

// ---- events a world can react to, derived by diffing live resources ----

export const WorkspaceState = z.object({
  workspaceId: z.string(), chats: z.array(Chat), activity: Activity, presence: z.array(Presence), runs: ActiveRuns,
  worldState: WorldState.optional(),          // present when the watch names a world
});
export type WorkspaceState = z.infer<typeof WorkspaceState>;
export const ChatSnapshot = z.object({
  chatId: z.string(), messages: z.array(Message), runs: z.array(Run), events: z.record(z.string(), z.array(RunEventShape)), changes: z.array(Change),
});
export type ChatSnapshot = Omit<z.infer<typeof ChatSnapshot>, "events"> & { events: Record<string, RunEvent[]> };

/**
 * Hints, not truth. A snapshot comes first; events describe what changed since the last one. After a
 * reconnect the next snapshot is the truth again, so a world never has to replay anything.
 */
export type WorldEvent =
  | { type: "workspace.snapshot"; state: WorkspaceState }
  | { type: "chat.created"; chat: Chat }
  | { type: "chat.updated"; chat: Chat; previous: Chat }
  | { type: "chat.removed"; chatId: string }
  | { type: "chat.status"; chatId: string; status: ChatActivity | "idle"; previous: ChatActivity | "idle" }
  | { type: "person.arrived"; login: string; chatId: string | null; world: string | null }
  | { type: "person.moved"; login: string; chatId: string | null; previous: string | null; world: string | null }
  | { type: "person.left"; login: string; previous: string | null }
  | { type: "world.person"; world: string; login: string; data: unknown; previous: unknown }
  | { type: "world.chat"; world: string; chatId: string; data: unknown; previous: unknown }
  | { type: "world.workspace"; world: string; data: unknown; previous: unknown }
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
export type WorldEventType = WorldEvent["type"];
