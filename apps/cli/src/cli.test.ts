import { expect, it } from "vitest";
import { Beam, type Transport } from "@beam/sdk";
import { actionCall, actionTable, loginScopes, parseFlags, resourceCall, resourceTable } from "./args.ts";
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
    mutation: async (fn: string, args: Record<string, unknown>) => fn === "v1/messages:send" ? { id: "m9", kind: "text", runner: null, echo: args } : null,
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
  expect(lines.splice(0)).toEqual([{ id: 2, error: "chats.get needs chatId" }, { id: 3, error: 'unknown op "delete"; use get, subscribe, watch, unsubscribe, do or resources' }, { error: "not JSON" }]);

  await server.handle(JSON.stringify({ id: "w", op: "watch", workspaceId: "ws" }));
  expect([...subs.keys()].sort()).toEqual(["v1/chats:activity", "v1/chats:list", "v1/people:presence", "v1/runs:active"]);
  server.close();
  expect(subs.size).toBe(0);
});

it("reads actions from the command line, parsing JSON only where the contract says so", () => {
  expect(actionCall("messages.send", ["chatId=c1", "text=hi @claude = friend"])).toEqual({ action: "messages.send", args: { chatId: "c1", text: "hi @claude = friend" } });
  expect(actionCall("layers.set", ["workspaceId=ws", "layer=office", "scope=person", 'data={"x":3}'])).toMatchObject({ args: { data: { x: 3 } } });
  expect(actionCall("layers.set", ["workspaceId=ws", "layer=office", "scope=workspace", "data=null"])).toMatchObject({ args: { data: null } });
  expect(() => actionCall("layers.set", ["workspaceId=ws", "layer=office", "scope=person"])).toThrow("needs data (null removes it)");
  expect(() => actionCall("layers.set", ["workspaceId=ws", "layer=o", "scope=person", "data={x"])).toThrow("data is JSON");
  expect(() => actionCall("messages.send", ["chatId=c1"])).toThrow("needs text");
  expect(() => actionCall("chats.delete", [])).toThrow('unknown action "chats.delete"');
  expect(actionTable()).toContain("runs.respond runId=… requestId=… decision=…");
});

it("asks for exactly the scopes named, always with read", () => {
  expect(loginScopes({})).toEqual(["read"]);
  expect(loginScopes({ scopes: "chat:write, run:respond" })).toEqual(["read", "chat:write", "run:respond"]);
  expect(loginScopes({ write: true })).toContain("layer:state");
  expect(() => loginScopes({ scopes: "admin" })).toThrow('unknown scope "admin"');
});

it("acts over JSON lines", async () => {
  const { beam } = fakeBeam();
  const lines: any[] = [];
  const server = createServer(beam, (m) => lines.push(m));
  await server.handle(JSON.stringify({ id: 1, op: "do", action: "messages.send", args: { chatId: "c1", text: "hi" } }));
  await server.handle(JSON.stringify({ id: 2, op: "do", action: "runs.interrupt", args: {} }));
  await server.handle(JSON.stringify({ id: 3, op: "resources" }));
  expect(lines[0]).toEqual({ id: 1, value: { id: "m9", kind: "text", runner: null, echo: { chatId: "c1", text: "hi", token: "blt_x" } } });
  expect(lines[1]).toEqual({ id: 2, error: "runs.interrupt needs runId" });
  expect(Object.keys(lines[2].value)).toEqual(["resources", "actions"]);
  expect(lines[2].value.actions["runs.respond"].scope).toBe("run:respond");
});
