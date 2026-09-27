#!/usr/bin/env node
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { connect, type Beam, type LayerEvent } from "@beam/sdk";
import { parseFlags, resourceCall, resourceTable } from "./args.ts";
import { configFile, credentials, forgetConfig } from "./config.ts";
import { login } from "./login.ts";
import { createServer } from "./serve.ts";

const HELP = `beam: Beam's engine for interfaces you build yourself. Output is JSON; streams are one JSON value per line.

  beam login [--name NAME]              connect this machine to your Beam account (read-only)
  beam logout                           end this machine's token
  beam whoami                           who the token acts for, and what it may do

  beam resources                        everything you can read, with its arguments
  beam get <resource> [key=value…]      read once           e.g. beam get chats.list workspaceId=…
  beam sub <resource> [key=value…]      follow; a line per change
  beam watch [workspaceId]              a workspace as events: people moving, agents working, asking, landing
  beam watch --chat <chatId>            a chat as events: messages, streaming replies, tool steps, PRs
  beam serve                            the whole API as JSON lines on stdin/stdout, for layers in any language

  --pretty    indent JSON          BEAM_TOKEN, BEAM_CONVEX_URL    override the saved token and backend
  Guide: docs/layers.md`;

const out = (value: unknown, pretty: boolean) => process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + "\n");
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^.*Uncaught Error: /s, "").split("\n")[0]!;

async function beam(): Promise<Beam> {
  const c = await credentials();
  if (!c) throw new Error("not signed in; run `beam login`");
  return connect({ token: c.token, url: c.url });
}

/** Keep the process alive until Ctrl-C or the stream's end, then unsubscribe and close cleanly. */
function hold(b: Beam, stop: () => void): Promise<void> {
  return new Promise((resolve) => {
    const end = () => { stop(); void b.close().finally(resolve); };
    process.once("SIGINT", end);
    process.once("SIGTERM", end);
    process.stdout.once("error", end); // a closed pipe: `beam watch | head`
  });
}
const failAndExit = (e: Error) => { process.stderr.write(`beam: ${clean(e)}\n`); process.exit(1); };

async function main(argv: string[]): Promise<void> {
  const { positional: [cmd, ...rest], flags } = parseFlags(argv);
  const pretty = flags["pretty"] === true || (process.stdout.isTTY && cmd === "get") || cmd === "whoami";
  switch (cmd) {
    case undefined: case "help": case "-h": process.stdout.write(HELP + "\n"); return;
    case "login": {
      const name = typeof flags["name"] === "string" ? flags["name"] : `beam CLI on ${hostname().replace(/\.local$/, "")}`;
      const { login: who } = await login({ name, scopes: ["read"], log: (l) => process.stderr.write(l + "\n") });
      process.stderr.write(`Signed in as ${who}. Token saved to ${configFile()}.\n`);
      return;
    }
    case "logout": {
      const c = await credentials();
      if (c) { const b = connect({ token: c.token, url: c.url }); await b.revoke().catch(() => {}); await b.close(); }
      await forgetConfig();
      process.stderr.write("Signed out.\n");
      return;
    }
    case "whoami": { const b = await beam(); out(await b.get("me.get"), pretty); await b.close(); return; }
    case "resources": process.stdout.write(resourceTable() + "\n"); return;
    case "get": {
      const { resource, args } = resourceCall(rest[0], rest.slice(1));
      const b = await beam();
      try { out(await b.get(resource, args as never), pretty); } finally { await b.close(); }
      return;
    }
    case "sub": {
      const { resource, args } = resourceCall(rest[0], rest.slice(1));
      const b = await beam();
      return hold(b, b.subscribe(resource, args as never, (v) => out(v, pretty), failAndExit));
    }
    case "watch": {
      const b = await beam();
      const emit = (e: LayerEvent) => out(e, pretty);
      if (typeof flags["chat"] === "string") return hold(b, b.watchChat(flags["chat"], emit, failAndExit));
      let workspaceId = rest[0] ?? (typeof flags["workspace"] === "string" ? flags["workspace"] : undefined);
      if (!workspaceId) {
        const all = await b.get("workspaces.list");
        if (all.length !== 1) throw new Error(`you are in ${all.length} workspaces; pass one: ${all.map((w) => `${w.id} (${w.name})`).join(", ")}`);
        workspaceId = all[0]!.id;
      }
      return hold(b, b.watchWorkspace(workspaceId, emit, failAndExit));
    }
    case "serve": {
      const b = await beam();
      const server = createServer(b, (m) => out(m, false));
      await server.hello();
      const lines = createInterface({ input: process.stdin });
      lines.on("line", (l) => void server.handle(l));
      await new Promise<void>((resolve) => { lines.once("close", resolve); process.once("SIGTERM", resolve); });
      server.close();
      await b.close();
      return;
    }
    default: throw new Error(`unknown command "${cmd}"; run \`beam help\``);
  }
}

main(process.argv.slice(2)).then(() => process.exit(0), failAndExit);
