import { ACTIONS, RESOURCES, Scope, type ActionName, type ResourceName } from "@beam/contracts/layer";

/** `chats.list workspaceId=abc` → a known resource and exactly its arguments. Pure, so it is tested alone. */
export function resourceCall(name: string | undefined, rest: readonly string[]): { resource: ResourceName; args: Record<string, string> } {
  if (!name) throw new Error("name a resource; `beam resources` lists them");
  if (!(name in RESOURCES)) throw new Error(`unknown resource "${name}"; \`beam resources\` lists them`);
  const resource = name as ResourceName;
  const args: Record<string, string> = {};
  for (const pair of rest) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got "${pair}"`);
    args[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return { resource, args: checkArgs(resource, args) };
}

export function checkArgs(resource: ResourceName, args: Record<string, unknown>): Record<string, string> {
  const want: readonly string[] = RESOURCES[resource].args;
  for (const key of Object.keys(args)) if (!want.includes(key)) throw new Error(`${resource} takes ${want.length ? want.join(", ") : "no arguments"}, not ${key}`);
  for (const key of want) if (typeof args[key] !== "string" || !args[key]) throw new Error(`${resource} needs ${key}`);
  return args as Record<string, string>;
}

/** Flags anywhere: `--chat id`, `--name "Hamster office"`, `--pretty`. Everything else is positional. */
export function parseFlags(argv: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    const next = argv[i + 1];
    if (inline !== undefined) flags[key!] = inline;
    else if (next !== undefined && !next.startsWith("--") && VALUED.has(key!)) { flags[key!] = next; i++; }
    else flags[key!] = true;
  }
  return { positional, flags };
}
const VALUED = new Set(["chat", "name", "workspace", "scopes", "mention", "run", "layer"]);

/** `messages.send chatId=… text="hi"`: values are strings, except `json` arguments, which parse as JSON. */
export function actionCall(name: string | undefined, rest: readonly string[]): { action: ActionName; args: Record<string, unknown> } {
  if (!name || !(name in ACTIONS)) throw new Error(`unknown action "${name ?? ""}"; \`beam actions\` lists them`);
  const action = name as ActionName;
  const kinds = ACTIONS[action].args as Record<string, string>;
  const args: Record<string, unknown> = {};
  for (const pair of rest) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, i), value = pair.slice(i + 1);
    if (kinds[key]?.startsWith("json")) {
      try { args[key] = JSON.parse(value); } catch { throw new Error(`${key} is JSON; got ${value}`); }
    } else args[key] = value;
  }
  return { action, args: checkActionArgs(action, args) };
}

export function checkActionArgs(action: ActionName, args: Record<string, unknown>): Record<string, unknown> {
  const kinds = ACTIONS[action].args as Record<string, string>;
  for (const key of Object.keys(args)) if (!(key in kinds)) throw new Error(`${action} takes ${Object.keys(kinds).join(", ")}, not ${key}`);
  for (const [key, kind] of Object.entries(kinds)) {
    const v = args[key], optional = kind.endsWith("?"), json = kind.startsWith("json");
    if (json) { if (v === undefined && !optional) throw new Error(`${action} needs ${key} (null removes it)`); continue; }
    if (v === undefined || v === null) { if (!optional) throw new Error(`${action} needs ${key}`); continue; }
    if (typeof v !== "string" || !v) throw new Error(`${action}: ${key} is a string`);
  }
  return args;
}

/** `--scopes chat:write,run:respond`, or `--write` for every scope. Read is always included. */
export function loginScopes(flags: Record<string, string | true>): string[] {
  if (flags["write"] === true) return [...Scope.options];
  const asked = typeof flags["scopes"] === "string" ? flags["scopes"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const s of asked) if (!Scope.safeParse(s).success) throw new Error(`unknown scope "${s}"; scopes: ${Scope.options.join(", ")}`);
  return [...new Set(["read", ...asked])];
}

export function actionTable(): string {
  const rows = Object.entries(ACTIONS).map(([name, a]) => [`${name}${Object.entries(a.args).map(([k, kind]) => ` ${k}=${kind.endsWith("?") ? "[…]" : "…"}`).join("")}`, `${a.scope}: ${a.about}`]);
  const width = Math.max(...rows.map(([a]) => a!.length));
  return rows.map(([a, b]) => `${a!.padEnd(width)}  ${b}`).join("\n");
}

export function resourceTable(): string {
  const rows = Object.entries(RESOURCES).map(([name, r]) => [`${name}${r.args.map((a) => ` ${a}=…`).join("")}`, r.about]);
  const width = Math.max(...rows.map(([a]) => a!.length));
  return rows.map(([a, b]) => `${a!.padEnd(width)}  ${b}`).join("\n");
}
