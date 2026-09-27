import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ACTIONS, RESOURCES, type ActionArgs, type ActionName, type ActionResult, type ChatSnapshot, type WorldEvent, type ResourceArgs, type ResourceName, type ResourceValue, type StateScope, type WorkspaceState } from "@beam/contracts/worlds";
import { diffChat, diffWorkspace } from "./diff.ts";

/** What the SDK needs from a Convex connection. Tests and other runtimes can supply their own. */
export interface Transport {
  query(fn: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(fn: string, args: Record<string, unknown>): Promise<unknown>;
  subscribe(fn: string, args: Record<string, unknown>, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export const DEFAULT_URL = "https://cautious-fish-858.convex.cloud";

/**
 * Beam's refusals arrive as ConvexErrors carrying a sentence ("this token may not chat:write"). Hand callers a
 * plain Error with just that sentence, not Convex's request-id wrapping.
 */
export function plainError(e: unknown): Error {
  const data = (e as { data?: unknown } | null)?.data;
  if (typeof data === "string") return new Error(data);
  const message = e instanceof Error ? e.message : String(e);
  return new Error(message.replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?/, "").replace(/^.*Uncaught (Convex)?Error: /s, "").split("\n")[0] || message);
}

/** Errors reach callers through promises and onError, so the Convex client's own console logging is off by default. */
export function convexTransport(url: string, opts: { logs?: boolean } = {}): Transport {
  const client = new ConvexClient(url, { logger: opts.logs ?? false });
  const ref = (fn: string) => makeFunctionReference<"query">(fn);
  return {
    query: (fn, args) => client.query(ref(fn), args).catch((e) => { throw plainError(e); }),
    mutation: (fn, args) => client.mutation(makeFunctionReference<"mutation">(fn), args).catch((e) => { throw plainError(e); }),
    subscribe: (fn, args, onValue, onError) => { const stop = client.onUpdate(ref(fn), args, onValue, (e) => onError(plainError(e))); return () => stop(); },
    close: () => client.close(),
  };
}

export type Unsubscribe = () => void;
type OnError = (error: Error) => void;
const reportError: OnError = (e) => console.error(`[beam] ${e.message}`);

/**
 * A connection to Beam as one person, through an app token. Every resource can be read once with `get`
 * or followed with `subscribe`, which calls back with the whole value each time it changes.
 */
export class Beam {
  private readonly transport: Transport;
  private readonly token: string;
  constructor(transport: Transport, token: string) { this.transport = transport; this.token = token; }

  get<R extends ResourceName>(resource: R, ...[args]: Args<R>): Promise<ResourceValue<R>> {
    return this.transport.query(RESOURCES[resource].fn, { ...args, token: this.token }) as Promise<ResourceValue<R>>;
  }

  subscribe<R extends ResourceName>(resource: R, args: ResourceArgs<R>, onValue: (value: ResourceValue<R>) => void, onError: OnError = reportError): Unsubscribe {
    return this.transport.subscribe(RESOURCES[resource].fn, { ...args, token: this.token }, (v) => onValue(v as ResourceValue<R>), onError);
  }

  /**
   * Do something as the person. Each action needs its scope on the token (see `ACTIONS`); a missing one
   * fails with "this token may not …". Optional arguments may be left out or null.
   */
  act<N extends ActionName>(action: N, args: ActionArgs<N>): Promise<ActionResult<N>> {
    const clean = Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined));
    return this.transport.mutation(ACTIONS[action].fn, { ...clean, token: this.token }) as Promise<ActionResult<N>>;
  }

  /** Post as the person. The first `@handle` of an agent in the chat starts it, or steers its live run. */
  send(chatId: string, text: string, opts: { mention?: string; runId?: string } = {}) { return this.act("messages.send", { chatId, text, ...opts }); }
  react(messageId: string, emoji: string) { return this.act("messages.react", { messageId, emoji }); }
  /** Answer an agent's open question or approval (`request.opened` in its events; `openRequests` in the SDK). */
  respond(runId: string, requestId: string, decision: string) { return this.act("runs.respond", { runId, requestId, decision }); }
  interrupt(runId: string) { return this.act("runs.interrupt", { runId }); }
  /** Say which chat the person is in (null for none), and which world they are in it from. */
  focus(workspaceId: string, chatId: string | null, world?: string) { return this.act("people.focus", { workspaceId, chatId, ...(world ? { world } : {}) }); }
  /** Save this world's state for the person, a chat or the workspace. null removes it. */
  setState(workspaceId: string, world: string, scope: StateScope, data: unknown, chatId?: string) { return this.act("worlds.set", { workspaceId, world, scope, data, ...(chatId ? { chatId } : {}) }); }

  /**
   * For state that changes every frame, like a position: call the returned function as often as you like and
   * it sends at most one write per `interval` ms, always ending on the latest value.
   */
  placer(workspaceId: string, world: string, opts: { interval?: number; onError?: OnError } = {}): (data: unknown) => void {
    const interval = Math.max(opts.interval ?? 250, 150);
    let pending: { data: unknown } | null = null, timer: ReturnType<typeof setTimeout> | null = null, lastSent = 0;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const { data } = pending;
      pending = null;
      lastSent = Date.now();
      this.setState(workspaceId, world, "person", data).catch(opts.onError ?? reportError);
    };
    return (data) => {
      pending = { data };
      if (timer) return;
      timer = setTimeout(flush, Math.max(0, lastSent + interval - Date.now()));
    };
  }

  /**
   * Everything happening in a workspace as events: a `workspace.snapshot` once chats, status, presence and
   * runs have all arrived, then what changed each time any of them does. Name a world to also follow its
   * state (`world.person`, `world.chat`, `world.workspace`).
   */
  watchWorkspace(workspaceId: string, onEvent: (event: WorldEvent) => void, onError: OnError = reportError, opts: { world?: string } = {}): Unsubscribe {
    const parts: Partial<Omit<WorkspaceState, "workspaceId">> = {};
    let last: WorkspaceState | null = null;
    const update = <K extends keyof typeof parts>(key: K) => (value: NonNullable<(typeof parts)[K]>) => {
      parts[key] = value;
      if (!parts.chats || !parts.activity || !parts.presence || !parts.runs || (opts.world && !parts.worldState)) return;
      const next: WorkspaceState = { workspaceId, chats: parts.chats, activity: parts.activity, presence: parts.presence, runs: parts.runs, ...(parts.worldState ? { worldState: parts.worldState } : {}) };
      if (last) for (const e of diffWorkspace(last, next)) onEvent(e);
      else onEvent({ type: "workspace.snapshot", state: next });
      last = next;
    };
    const stops = [
      this.subscribe("chats.list", { workspaceId }, update("chats"), onError),
      this.subscribe("chats.activity", { workspaceId }, update("activity"), onError),
      this.subscribe("people.presence", { workspaceId }, update("presence"), onError),
      this.subscribe("runs.active", { workspaceId }, update("runs"), onError),
      ...(opts.world ? [this.subscribe("worlds.state", { workspaceId, world: opts.world }, update("worldState"), onError)] : []),
    ];
    return () => stops.forEach((stop) => stop());
  }

  /** One chat as events: a `chat.snapshot`, then messages posted and streaming, run events, and changes. */
  watchChat(chatId: string, onEvent: (event: WorldEvent) => void, onError: OnError = reportError): Unsubscribe {
    const parts: Partial<Omit<ChatSnapshot, "chatId">> = {};
    let last: ChatSnapshot | null = null;
    const update = <K extends keyof typeof parts>(key: K) => (value: NonNullable<(typeof parts)[K]>) => {
      parts[key] = value;
      if (!parts.messages || !parts.runs || !parts.events || !parts.changes) return;
      const next: ChatSnapshot = { chatId, messages: parts.messages, runs: parts.runs, events: parts.events, changes: parts.changes };
      if (last) for (const e of diffChat(last, next)) onEvent(e);
      else onEvent({ type: "chat.snapshot", snapshot: next });
      last = next;
    };
    const stops = [
      this.subscribe("messages.list", { chatId }, update("messages"), onError),
      this.subscribe("runs.list", { chatId }, update("runs"), onError),
      this.subscribe("runs.eventsForChat", { chatId }, update("events"), onError),
      this.subscribe("changes.list", { chatId }, update("changes"), onError),
    ];
    return () => stops.forEach((stop) => stop());
  }

  /** End this token everywhere. The person can also revoke it in Settings → Connected apps. */
  async revoke(): Promise<void> { await this.transport.mutation("v1/me:revoke", { token: this.token }); }

  close(): Promise<void> { return this.transport.close(); }
}

/** Resources without arguments can be read as `beam.get("workspaces.list")`. */
type Args<R extends ResourceName> = keyof ResourceArgs<R> extends never ? [args?: ResourceArgs<R>] : [args: ResourceArgs<R>];

/** Connect with a token from `beam login` (or BEAM_TOKEN). The URL defaults to Beam's production backend. */
export function connect(opts: { token: string; url?: string; transport?: Transport }): Beam {
  return new Beam(opts.transport ?? convexTransport(opts.url ?? DEFAULT_URL), opts.token);
}
