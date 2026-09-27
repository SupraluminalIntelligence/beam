import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { RESOURCES, type ChatSnapshot, type LayerEvent, type ResourceArgs, type ResourceName, type ResourceValue, type WorkspaceState } from "@beam/contracts/layer";
import { diffChat, diffWorkspace } from "./diff.ts";

/** What the SDK needs from a Convex connection. Tests and other runtimes can supply their own. */
export interface Transport {
  query(fn: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(fn: string, args: Record<string, unknown>): Promise<unknown>;
  subscribe(fn: string, args: Record<string, unknown>, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export const DEFAULT_URL = "https://cautious-fish-858.convex.cloud";

export function convexTransport(url: string): Transport {
  const client = new ConvexClient(url);
  const ref = (fn: string) => makeFunctionReference<"query">(fn);
  return {
    query: (fn, args) => client.query(ref(fn), args),
    mutation: (fn, args) => client.mutation(makeFunctionReference<"mutation">(fn), args),
    subscribe: (fn, args, onValue, onError) => { const stop = client.onUpdate(ref(fn), args, onValue, onError); return () => stop(); },
    close: () => client.close(),
  };
}

export type Unsubscribe = () => void;
type OnError = (error: Error) => void;
const reportError: OnError = (e) => console.error(`[beam] ${e.message}`);

/**
 * A connection to Beam as one person, through a layer token. Every resource can be read once with `get`
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
   * Everything happening in a workspace as events: a `workspace.snapshot` once chats, status, presence and
   * runs have all arrived, then what changed each time any of them does.
   */
  watchWorkspace(workspaceId: string, onEvent: (event: LayerEvent) => void, onError: OnError = reportError): Unsubscribe {
    const parts: Partial<Omit<WorkspaceState, "workspaceId">> = {};
    let last: WorkspaceState | null = null;
    const update = <K extends keyof typeof parts>(key: K) => (value: NonNullable<(typeof parts)[K]>) => {
      parts[key] = value;
      if (!parts.chats || !parts.activity || !parts.presence || !parts.runs) return;
      const next: WorkspaceState = { workspaceId, chats: parts.chats, activity: parts.activity, presence: parts.presence, runs: parts.runs };
      if (last) for (const e of diffWorkspace(last, next)) onEvent(e);
      else onEvent({ type: "workspace.snapshot", state: next });
      last = next;
    };
    const stops = [
      this.subscribe("chats.list", { workspaceId }, update("chats"), onError),
      this.subscribe("chats.activity", { workspaceId }, update("activity"), onError),
      this.subscribe("people.presence", { workspaceId }, update("presence"), onError),
      this.subscribe("runs.active", { workspaceId }, update("runs"), onError),
    ];
    return () => stops.forEach((stop) => stop());
  }

  /** One chat as events: a `chat.snapshot`, then messages posted and streaming, run events, and changes. */
  watchChat(chatId: string, onEvent: (event: LayerEvent) => void, onError: OnError = reportError): Unsubscribe {
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
