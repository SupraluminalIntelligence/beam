import { API_VERSION, RESOURCES, type ResourceName } from "@beam/contracts/layer";
import type { Beam, Unsubscribe } from "@beam/sdk";
import { checkArgs } from "./args.ts";

/**
 * `beam serve`: the layer API as JSON lines, for interfaces written in anything that can spawn a process.
 *
 *   → {"id":1,"op":"get","resource":"chats.list","args":{"workspaceId":"…"}}      ← {"id":1,"value":[…]}
 *   → {"id":2,"op":"subscribe","resource":"messages.list","args":{"chatId":"…"}}  ← {"id":2,"value":[…]} on every change
 *   → {"id":3,"op":"watch","workspaceId":"…"}   (or "chatId")                      ← {"id":3,"event":{…}} per event
 *   → {"id":2,"op":"unsubscribe"}                                                   ← {"id":2,"done":true}
 *   → {"id":4,"op":"resources"}                                                     ← {"id":4,"value":{…}}
 * Failures answer {"id":…,"error":"…"}. The first line out is {"ready":true,"api":1,"me":{…}}.
 */
export function createServer(beam: Beam, write: (msg: object) => void) {
  const live = new Map<string | number, Unsubscribe>();
  const catalog = Object.fromEntries(Object.entries(RESOURCES).map(([k, r]) => [k, { args: r.args, about: r.about }]));

  async function handle(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: { id?: string | number; op?: string; resource?: string; args?: Record<string, unknown>; workspaceId?: string; chatId?: string };
    try { msg = JSON.parse(line); } catch { write({ error: "not JSON" }); return; }
    const id = msg.id ?? null;
    const fail = (e: unknown) => write({ id, error: e instanceof Error ? e.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : String(e) });
    try {
      switch (msg.op) {
        case "resources": write({ id, value: catalog }); return;
        case "get": { const { resource, args } = call(msg); write({ id, value: await beam.get(resource, args as never) }); return; }
        case "subscribe": {
          const { resource, args } = call(msg);
          track(id, beam.subscribe(resource, args as never, (value) => write({ id, value }), fail));
          return;
        }
        case "watch": {
          if (msg.chatId) track(id, beam.watchChat(msg.chatId, (event) => write({ id, event }), fail));
          else if (msg.workspaceId) track(id, beam.watchWorkspace(msg.workspaceId, (event) => write({ id, event }), fail));
          else throw new Error("watch needs workspaceId or chatId");
          return;
        }
        case "unsubscribe": { live.get(id!)?.(); live.delete(id!); write({ id, done: true }); return; }
        default: throw new Error(`unknown op "${msg.op}"; use get, subscribe, watch, unsubscribe or resources`);
      }
    } catch (e) { fail(e); }
  }

  function call(msg: { resource?: string; args?: Record<string, unknown> }) {
    const resource = msg.resource as ResourceName;
    if (!resource || !(resource in RESOURCES)) throw new Error(`unknown resource "${msg.resource}"`);
    return { resource, args: checkArgs(resource, msg.args ?? {}) };
  }
  function track(id: string | number | null, stop: Unsubscribe) {
    if (id === null) { stop(); throw new Error("subscribe and watch need an id to unsubscribe with"); }
    live.get(id)?.();
    live.set(id, stop);
  }

  return {
    handle,
    async hello() { write({ ready: true, api: API_VERSION, me: await beam.get("me.get") }); },
    close() { for (const stop of live.values()) stop(); live.clear(); },
  };
}
