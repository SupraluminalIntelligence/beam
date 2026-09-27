import { expect, it } from "vitest";
import { Beam, type Transport } from "@beam/sdk";
import { parseFlags, resourceCall, resourceTable } from "./args.ts";
import { createServer } from "./serve.ts";

it("reads a resource call from the command line and checks its arguments", () => {
  expect(resourceCall("chats.list", ["workspaceId=ws1"])).toEqual({ resource: "chats.list", args: { workspaceId: "ws1" } });
  expect(resourceCall("workspaces.list", [])).toEqual({ resource: "workspaces.list", args: {} });
  expect(() => resourceCall("chats.delete", [])).toThrow('unknown resource "chats.delete"');
  expect(() => resourceCall("chats.list", [])).toThrow("chats.list needs workspaceId");
  expect(() => resourceCall("chats.list", ["workspaceId=a", "chatId=b"])).toThrow("not chatId");
  expect(() => resourceCall("chats.list", ["ws1"])).toThrow("expected key=value");
});

it("takes flags anywhere", () => {
  expect(parseFlags(["watch", "--chat", "c1", "--pretty"])).toEqual({ positional: ["watch"], flags: { chat: "c1", pretty: true } });
  expect(parseFlags(["login", "--name=Hamster office"])).toEqual({ positional: ["login"], flags: { name: "Hamster office" } });
  expect(resourceTable()).toContain("messages.list chatId=…");
});

function fakeBeam() {
  const subs = new Map<string, (v: unknown) => void>();
  const transport: Transport = {
    query: async (fn, args) => fn === "v1/me:get" ? { login: "alice" } : { fn, args },
    mutation: async () => null,
    subscribe: (fn, _args, onValue) => { subs.set(fn, onValue); return () => subs.delete(fn); },
    close: async () => {},
  };
  return { beam: new Beam(transport, "blt_x"), subs };
}

it("serves the API as JSON lines", async () => {
  const { beam, subs } = fakeBeam();
  const lines: any[] = [];
  const server = createServer(beam, (m) => lines.push(m));
  await server.hello();
  expect(lines.shift()).toEqual({ ready: true, api: 1, me: { login: "alice" } });

  await server.handle(JSON.stringify({ id: 1, op: "get", resource: "chats.get", args: { chatId: "c1" } }));
  expect(lines.shift()).toEqual({ id: 1, value: { fn: "v1/chats:get", args: { chatId: "c1", token: "blt_x" } } });

  await server.handle(JSON.stringify({ id: "m", op: "subscribe", resource: "messages.list", args: { chatId: "c1" } }));
  subs.get("v1/messages:list")!([{ id: "m1" }]);
  expect(lines.shift()).toEqual({ id: "m", value: [{ id: "m1" }] });
  await server.handle(JSON.stringify({ id: "m", op: "unsubscribe" }));
  expect(lines.shift()).toEqual({ id: "m", done: true });
  expect(subs.has("v1/messages:list")).toBe(false);

  await server.handle(JSON.stringify({ id: 2, op: "get", resource: "chats.get", args: {} }));
  await server.handle(JSON.stringify({ id: 3, op: "delete" }));
  await server.handle("{nope");
  expect(lines.splice(0)).toEqual([{ id: 2, error: "chats.get needs chatId" }, { id: 3, error: 'unknown op "delete"; use get, subscribe, watch, unsubscribe or resources' }, { error: "not JSON" }]);

  await server.handle(JSON.stringify({ id: "w", op: "watch", workspaceId: "ws" }));
  expect([...subs.keys()].sort()).toEqual(["v1/chats:activity", "v1/chats:list", "v1/people:presence", "v1/runs:active"]);
  server.close();
  expect(subs.size).toBe(0);
});
