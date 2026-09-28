import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Agent, type RunEvent } from "@beam/contracts";
import type { Session } from "../adapter.ts";
import { AsyncQueue } from "../queue.ts";
import { claudeAdapter } from "./index.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(), createSdkMcpServer: vi.fn(), tool: vi.fn() }));
vi.mock("../path.ts", () => ({ which: vi.fn(async () => "/test/claude") }));

const sessions: Session[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.stop(); vi.clearAllMocks(); });
async function setup(permissionMode: "auto" | "ask" | "plan" | "allowlist", resumeCursor: unknown = null) {
  const stream = new AsyncQueue<never>();
  vi.mocked(query).mockReturnValue(Object.assign(stream, { interrupt: vi.fn(), close: () => stream.close() }) as unknown as ReturnType<typeof query>);
  const session = await claudeAdapter.start({
    runId: "run", agent: Agent.parse({ id: "a", workspaceId: "w", harness: "claude", handle: "claude", model: "Fable 5.1", effort: "high", permissionMode, alwaysAllow: [], contextPolicy: "whole-chat" }),
    cwd: "/tmp/beam-test", resumeCursor, systemContext: "", tools: [],
  });
  sessions.push(session);
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  const events: RunEvent[] = [];
  void (async () => { for await (const event of session.events) events.push(event); })();
  const check = (name: string, input: Record<string, unknown>, requestId: string) => options.canUseTool!(name, input, { requestId, signal: new AbortController().signal, toolUseID: requestId });
  const sent = vi.mocked(query).mock.calls.at(-1)![0].prompt as AsyncIterable<{ uuid: string }>;
  return { session, options, events, check, stream, sent: sent[Symbol.asyncIterator]() };
}

describe("Claude permissions", () => {
  it.each([null, { sessionId: "previous" }])("auto bypasses permissions on new and resumed sessions (%j)", async (resumeCursor) => {
    const { options, events, check } = await setup("auto", resumeCursor);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    if (resumeCursor) expect(options.resume).toBe("previous");
    for (const [name, input] of [["Bash", { command: "rm -rf /tmp/data" }], ["Edit", { file_path: "/outside/file" }], ["mcp__test__write", { data: "test" }]] as const) {
      expect(await check(name, input, name)).toEqual({ behavior: "allow", updatedInput: input });
    }
    expect(events.filter((e) => e.type === "request.opened")).toHaveLength(0);
  });

  it.each(["ask", "plan", "allowlist"] as const)("keeps %s approvals interactive", async (mode) => {
    const { session, options, events, check } = await setup(mode);
    expect(options.permissionMode).toBe({ ask: "default", plan: "plan", allowlist: "acceptEdits" }[mode]);
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    const result = check("Bash", { command: "rm -rf /tmp/data" }, "approval");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual(expect.objectContaining({ type: "request.opened", kind: "approval" }));
    await session.respond("approval", "deny");
    expect(await result).toEqual(expect.objectContaining({ behavior: "deny" }));
  });
});

describe("Claude probe usage", () => {
  const probe = (account: Record<string, unknown>, usage: () => Promise<unknown>) => {
    vi.mocked(query).mockReturnValue({ initializationResult: async () => ({ account }), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close: vi.fn() } as unknown as ReturnType<typeof query>);
    return claudeAdapter.probe();
  };
  it("reads plan windows for a subscription", async () => {
    const s = await probe({ email: "a@b.c", subscriptionType: "max" }, async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 30, resets_at: null } } }));
    expect(s.usage?.windows.map((w) => [w.id, w.usedPercent])).toEqual([["five_hour", 30]]);
  });
  it("marks API-key and outside-provider sign-ins unsupported without asking", async () => {
    const usage = vi.fn();
    expect((await probe({ tokenSource: "apiKey" }, usage)).usage?.unavailable).toBe("unsupported");
    expect((await probe({ apiProvider: "bedrock" }, usage)).usage?.unavailable).toBe("unsupported");
    expect(usage).not.toHaveBeenCalled();
  });
  it("reports a failed read so the last good numbers stay", async () => {
    const s = await probe({ email: "a@b.c", subscriptionType: "pro" }, async () => { throw new Error("gone"); });
    expect(s.auth).toBe("authenticated");
    expect(s.usage?.unavailable).toBe("failed");
  });
});

describe("Claude turns", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", result: "", ...extra }) as never;
  it("does not end the turn on a turn the CLI started itself while our message waits", async () => {
    const { session, events, stream, sent } = await setup("auto", { sessionId: "previous" });
    await session.send("Read the results", "m1");
    const { uuid } = (await sent.next()).value;
    // Background tasks from the previous run stopped: the CLI answers their notification first.
    stream.push(result({ queued_turn_count: 1 }));
    await settle();
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    stream.push(result({ user_message_uuid: uuid, queued_turn_count: 0, result: "Here are the results" }));
    await settle();
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "content.final", text: "Here are the results" }));
  });
  it("ends turns as before with a CLI that neither echoes sends nor counts its queue", async () => {
    const { session, events, stream, sent } = await setup("auto");
    await session.send("Hello", "m1");
    await sent.next();
    stream.push(result({ result: "Hi" }));
    await settle();
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });
});
