import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, type RunEvent } from "@beam/contracts";
import type { StartSession } from "../adapter.ts";
import { CodexSession, type Rpc } from "./session.ts";

class FakeRpc implements Rpc {
  notifications: Rpc["notifications"] = [];
  requests: Rpc["requests"] = [];
  exit!: (code: number | null) => void;
  exited = new Promise<number | null>((resolve) => { this.exit = resolve; });
  notify = vi.fn(); respond = vi.fn(); reject = vi.fn(); kill = vi.fn(() => this.exit(0));
  turns = 0;
  request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "model/list") return { data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] }], nextCursor: null };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread" } };
    if (method === "turn/start") {
      const turn = { id: `t${++this.turns}`, status: "inProgress" };
      this.emit("turn/started", { turn });
      return { turn };
    }
    return {};
  }) as Rpc["request"] & ReturnType<typeof vi.fn>;
  emit(method: string, params: Record<string, unknown>) { for (const fn of this.notifications) fn(method, { threadId: "thread", ...params }); }
  ask(id: string | number, method: string, params: Record<string, unknown>) { for (const fn of this.requests) fn(id, method, { threadId: "thread", ...params }); }
  done(id = `t${this.turns}`, status = "completed") { this.emit("turn/completed", { turn: { id, status } }); }
}

const input = (patch: Partial<StartSession> = {}): StartSession => ({
  runId: "run", agent: Agent.parse({ id: "a", workspaceId: "w", harness: "codex", handle: "codex", model: "GPT-5.6 Sol", effort: "max", permissionMode: "ask", alwaysAllow: [], contextPolicy: "whole-chat" }),
  cwd: "/tmp/beam-test", resumeCursor: null, systemContext: "The shared chat", tools: [], ...patch,
});
const sessions: CodexSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.stop(); });
async function setup(patch: Partial<StartSession> = {}) {
  const rpc = new FakeRpc();
  const session = await CodexSession.start(input(patch), rpc);
  sessions.push(session);
  const events: RunEvent[] = [];
  void (async () => { for await (const event of session.events) events.push(event); })();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  return { rpc, session, events, tick };
}

describe("Codex app-server adapter", () => {
  it("starts with the chosen model, maximum supported effort, Beam context and tools", async () => {
    const tool = { name: "attach_repo", description: "Attach repo", schema: { repo: z.string() }, run: vi.fn(async () => "ok") };
    const { rpc, session } = await setup({ tools: [tool] });
    expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ model: "gpt-5.6-sol", developerInstructions: "The shared chat", approvalPolicy: "untrusted", sandbox: "workspace-write", dynamicTools: [expect.objectContaining({ type: "function", name: "attach_repo", inputSchema: expect.objectContaining({ type: "object", required: ["repo"] }) })] }));
    await session.send("hello", "m1");
    expect(rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ effort: "xhigh", clientUserMessageId: "m1" }));
    expect(session.resumeCursor()).toMatchObject({ threadId: "thread", toolsHash:expect.any(String) });
  });

  it("reports plan limits the app server streams mid-run", async () => {
    const { rpc, events, tick } = await setup();
    rpc.emit("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 } } });
    rpc.emit("account/rateLimits/updated", { rateLimits: { limitId: "spark", primary: { usedPercent: 99 } } });
    await tick();
    expect(events.filter((e) => e.type === "usage.updated")).toEqual([{ type: "usage.updated", runId: "run", windows: [{ id: "primary", kind: "session", label: "5-hour session", usedPercent: 42, resetsAt: 1_900_000_000_000 }] }]);
  });

  it("resumes a persisted thread with current settings without replaying history", async () => {
    const { rpc, events } = await setup({ resumeCursor: { threadId: "thread" } });
    expect(rpc.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "thread", developerInstructions: "The shared chat" }));
    expect(rpc.request).not.toHaveBeenCalledWith("thread/start", expect.anything());
    expect(events.map((e) => e.type)).toEqual(["session.started"]);
  });

  it("coalesces message items into one Beam message and completes one turn per queued steer", async () => {
    const { rpc, session, events, tick } = await setup();
    await session.send("first", "m1"); await tick();
    await session.send("second", "m2");
    await session.send("third", "m3");
    expect(rpc.turns).toBe(1);
    rpc.emit("item/agentMessage/delta", { itemId: "msg-a", delta: "Hi" });
    rpc.emit("item/completed", { item: { type: "agentMessage", id: "msg-a", text: "Hi!" } });
    rpc.emit("item/started", { item: { type: "commandExecution", id: "cmd", command: "git status" } });
    rpc.emit("item/completed", { item: { type: "commandExecution", id: "cmd", command: "git status", status: "completed", exitCode: 0, aggregatedOutput: "clean", durationMs: 12 } });
    rpc.emit("item/completed", { item: { type: "agentMessage", id: "msg-b", text: "Done" } });
    rpc.done(); await tick(); expect(rpc.turns).toBe(2);
    rpc.done(); await tick(); expect(rpc.turns).toBe(3);
    rpc.done(); await tick();
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(3);
    expect(events.filter((e) => e.type === "steer.received")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "content.final", messageId: "t1", text: "Hi!" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "content.final", messageId: "t1", text: "Hi!\n\nDone" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", detail: "clean", ok: true, ms: 12 }));
  });

  it("validates dynamic tool arguments and returns both successes and failures to Codex", async () => {
    const tool = { name: "attach_repo", description: "attach", schema: { repo: z.string() }, run: vi.fn(async ({ repo }) => `Mounted ${repo}`) };
    const { rpc, tick } = await setup({ tools: [tool] });
    rpc.ask(1, "item/tool/call", { tool: "attach_repo", arguments: { repo: "acme/app" } }); await tick();
    expect(rpc.respond).toHaveBeenCalledWith(1, { contentItems: [{ type: "inputText", text: "Mounted acme/app" }], success: true });
    rpc.ask(2, "item/tool/call", { tool: "attach_repo", arguments: { repo: 123 } }); await tick();
    expect(rpc.respond).toHaveBeenCalledWith(2, expect.objectContaining({ success: false }));
    expect(tool.run).toHaveBeenCalledTimes(1);
  });

  it("round-trips approvals, preserves string RPC ids and ignores duplicate answers", async () => {
    const { rpc, session, events, tick } = await setup();
    rpc.ask("approval", "item/commandExecution/requestApproval", { command: "npm test", availableDecisions: ["accept", "acceptForSession", "decline"] });
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "request.opened", options: ["allow", "always", "deny"] }));
    await session.respond("rpc:string:approval", "always", "alice");
    await session.respond("rpc:string:approval", "allow", "bob");
    await tick();
    expect(rpc.respond).toHaveBeenCalledExactlyOnceWith("approval", { decision: "acceptForSession" });
    expect(events).toContainEqual(expect.objectContaining({ type: "request.resolved", by: "alice", decision: "always" }));
  });

  it.each([null, { threadId: "thread" }])("uses full access for new and resumed auto sessions (%j)", async (resumeCursor) => {
    const agent = { ...input().agent, permissionMode: "auto" as const };
    const { rpc, session } = await setup({ agent, resumeCursor });
    expect(rpc.request).toHaveBeenCalledWith(resumeCursor ? "thread/resume" : "thread/start", expect.objectContaining({ approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" }));
    await session.send("work", "m1");
    expect(rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }));
  });

  it("auto mode accepts destructive commands, outside edits and permission grants without opening approval UI", async () => {
    const agent = { ...input().agent, permissionMode: "auto" as const };
    const { rpc, events, tick } = await setup({ agent });
    rpc.ask(1, "item/commandExecution/requestApproval", { command: "npm test" });
    rpc.ask(2, "item/commandExecution/requestApproval", { command: "rm -rf /tmp/data" });
    rpc.ask(3, "item/commandExecution/requestApproval", { command: "npm test", additionalPermissions: { fileSystem: { write: ["/outside"] } } });
    rpc.ask(4, "item/commandExecution/requestApproval", { command: "curl example.com", networkApprovalContext: { host: "example.com" }, availableDecisions: ["acceptForSession", "decline"] });
    rpc.emit("item/started", { item: { type: "fileChange", id: "outside", changes: [{ path: "/outside/file", diff: "+test" }] } });
    rpc.ask(5, "item/fileChange/requestApproval", { itemId: "outside", grantRoot: "/outside" });
    const permissions = { network: { enabled: true }, fileSystem: { write: ["/outside"] } };
    rpc.ask(6, "item/permissions/requestApproval", { permissions });
    await tick();
    for (const id of [1, 2, 3, 5]) expect(rpc.respond).toHaveBeenCalledWith(id, { decision: "accept" });
    expect(rpc.respond).toHaveBeenCalledWith(4, { decision: "acceptForSession" });
    expect(rpc.respond).toHaveBeenCalledWith(6, { permissions, scope: "turn" });
    expect(rpc.respond).toHaveBeenCalledTimes(6);
    expect(events.filter((e) => e.type === "request.opened")).toHaveLength(0);
  });

  it("keeps genuine questions visible in auto mode", async () => {
    const agent = { ...input().agent, permissionMode: "auto" as const };
    const { rpc, session, events, tick } = await setup({ agent });
    rpc.ask(7, "item/tool/requestUserInput", { questions: [{ id: "q", question: "Which project?" }] });
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "request.opened", kind: "input", prompt: "Which project?" }));
    expect(rpc.respond).not.toHaveBeenCalled();
    await session.respond("rpc:number:7:q", "Beam");
    expect(rpc.respond).toHaveBeenCalledWith(7, { answers: { q: { answers: ["Beam"] } } });
  });

  it("still requires broader grants in allow-list mode and denies them while planning", async () => {
    for (const permissionMode of ["allowlist", "plan"] as const) {
      const { rpc, events, tick } = await setup({ agent: { ...input().agent, permissionMode, alwaysAllow: ["npm test"] } });
      rpc.ask(1, "item/commandExecution/requestApproval", { command: "npm test", additionalPermissions: { network: { enabled: true } } });
      rpc.ask(2, "item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
      await tick();
      if (permissionMode === "plan") {
        expect(rpc.respond).toHaveBeenCalledWith(1, { decision: "decline" });
        expect(rpc.respond).toHaveBeenCalledWith(2, { permissions: {}, scope: "turn" });
        expect(events.filter((e) => e.type === "request.opened")).toHaveLength(0);
      } else {
        expect(rpc.respond).not.toHaveBeenCalled();
        expect(events.filter((e) => e.type === "request.opened")).toHaveLength(2);
      }
    }
  });

  it("collects multi-question input before responding and clears canceled requests", async () => {
    const { rpc, session, events, tick } = await setup();
    rpc.ask(8, "item/tool/requestUserInput", { questions: [{ id: "q1", question: "Which?", options: [{ label: "A", description: "First" }] }, { id: "q2", question: "Why?", options: null }] });
    await session.respond("rpc:number:8:q1", "A", "alice");
    expect(rpc.respond).not.toHaveBeenCalled();
    await session.respond("rpc:number:8:q2", "Because", "bob");
    expect(rpc.respond).toHaveBeenCalledWith(8, { answers: { q1: { answers: ["A"] }, q2: { answers: ["Because"] } } });
    rpc.ask(9, "item/fileChange/requestApproval", {});
    rpc.emit("serverRequest/resolved", { requestId: 9 }); await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "request.resolved", requestId: "rpc:number:9", decision: "cleared" }));
    await session.respond("rpc:number:9", "allow");
    expect(rpc.respond).not.toHaveBeenCalledWith(9, expect.anything());
  });

  it("keeps plan execution read-only until approval, then completes the same Beam turn", async () => {
    const agent = { ...input().agent, permissionMode: "plan" as const };
    const { rpc, session, events, tick } = await setup({ agent });
    await session.send("plan this", "m1"); await tick();
    expect(rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }));
    rpc.done(); await tick();
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    await session.respond("plan:t1", "allow", "alice");
    expect(rpc.request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({ sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }), collaborationMode: expect.objectContaining({ mode: "default" }) }));
    rpc.done(); await tick();
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("interrupts the current turn without launching queued work", async () => {
    const { rpc, session, tick } = await setup();
    await session.send("first", "m1"); await tick();
    await session.send("second", "m2");
    await session.interrupt(); rpc.done("t1", "interrupted"); await tick();
    expect(rpc.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread", turnId: "t1" });
    expect(rpc.turns).toBe(1);
  });

  it("reports retries without ending the run, but fails on terminal errors or process exit", async () => {
    const { rpc, events, tick } = await setup();
    rpc.emit("error", { error: { message: "retrying" }, willRetry: true }); await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "status", message: "retrying" }));
    expect(rpc.kill).not.toHaveBeenCalled();
    rpc.exit(1); await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", fatal: true }));
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("fails cleanly on a rejected turn start and rejects unknown server requests", async () => {
    const { rpc, session, events, tick } = await setup();
    rpc.ask(1, "future/request", {}); await tick();
    expect(rpc.reject).toHaveBeenCalledWith(1, "Beam does not support future/request");
    rpc.request.mockRejectedValueOnce(new Error("unsupported model"));
    await session.send("hello", "m1"); await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "unsupported model", fatal: true }));
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("does not resurrect a fast turn whose completion precedes the start response", async () => {
    const { rpc, session, events, tick } = await setup();
    rpc.request.mockImplementationOnce(async () => {
      rpc.emit("turn/started", { turn: { id: "fast" } });
      rpc.done("fast");
      return { turn: { id: "fast", status: "inProgress" } };
    });
    await session.send("quick", "m1"); await tick();
    await session.send("next", "m2"); await tick();
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(rpc.turns).toBe(1);
  });

  it("never exposes a request for a secret in the shared chat", async () => {
    const { rpc, events, tick } = await setup();
    rpc.ask(10, "item/tool/requestUserInput", { questions: [{ id: "secret", question: "API key?", isSecret: true }] }); await tick();
    expect(rpc.respond).toHaveBeenCalledWith(10, { answers: {} });
    expect(events.filter((e) => e.type === "request.opened")).toHaveLength(0);
  });
});

it("refreshes persisted agent tools when their schemas change",async()=>{
 const tool={name:"save_simulation",description:"Save",schema:{config:z.string()},run:async()=>"ok"};
 const initial=await setup({tools:[tool]});const cursor=initial.session.resumeCursor();await initial.session.stop();
 const same=await setup({tools:[tool],resumeCursor:cursor});expect(same.rpc.request).toHaveBeenCalledWith("thread/resume",expect.anything());await same.session.stop();
 const changed=await setup({tools:[{...tool,schema:{config:z.number()}}],resumeCursor:cursor,fallbackSystemContext:"Full original geometry request"});expect(changed.rpc.request).toHaveBeenCalledWith("thread/start",expect.objectContaining({dynamicTools:expect.any(Array),developerInstructions:"Full original geometry request"}));await changed.session.stop();
 const legacy=await setup({tools:[tool],resumeCursor:{threadId:"old"}});expect(legacy.rpc.request).toHaveBeenCalledWith("thread/start",expect.anything());await legacy.session.stop();
});
