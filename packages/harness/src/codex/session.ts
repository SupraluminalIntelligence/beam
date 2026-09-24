import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RunEvent } from "@beam/contracts";
import type { Session, StartSession } from "../adapter.ts";
import { AsyncQueue } from "../queue.ts";
import { matchesAllow, truncate } from "../tools.ts";
import type { JsonRpcChild } from "./rpc.ts";
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

// The subset of the app-server v2 protocol Beam consumes. Validate at the wire,
// allow additional fields so newer CLIs can extend notifications independently.
const Id = z.union([z.string(), z.number()]);
const Thread = z.object({ thread: z.object({ id: z.string() }) });
const Turn = z.object({ id: z.string(), status: z.string().optional(), error: z.object({ message: z.string() }).nullable().optional() });
const Envelope = z.object({ threadId: z.string().optional() }).passthrough();
const Item = z.object({
  id: z.string(), type: z.string(), text: z.string().optional(), command: z.string().optional(),
  tool: z.string().optional(), query: z.string().optional(), status: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(), exitCode: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(), success: z.boolean().nullable().optional(),
  changes: z.array(z.object({ path: z.string(), diff: z.string() })).optional(),
}).passthrough();
const Question = z.object({ id: z.string(), question: z.string(), isSecret: z.boolean().optional(), options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional() });
const Approval = z.object({ command: z.string().nullable().optional(), reason: z.string().nullable().optional(), grantRoot: z.string().nullable().optional(), availableDecisions: z.array(z.unknown()).nullable().optional() }).passthrough();
const Models = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() });

export type Rpc = Pick<JsonRpcChild, "request" | "notify" | "respond" | "reject" | "kill" | "notifications" | "requests" | "exited">;
type Pending = { rpcId: string | number | null; answer: (decision: string) => void | Promise<void> };

export class CodexSession implements Session {
  readonly events = new AsyncQueue<RunEvent>();
  private threadId = "";
  private toolsHash = "";
  private turnId: string | null = null;
  private logicalTurn: string | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private interrupted = false;
  private starting = false;
  private planning: boolean;
  private model: string;
  private effort: string;
  private readonly queue: { text: string; messageId: string }[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly texts = new Map<string, string>();
  private readonly completedTurns = new Set<string>();
  private readonly items = new Map<string, z.infer<typeof Item>>();
  private readonly allow: string[];
  private readonly input: StartSession;
  private readonly rpc: Rpc;

  private constructor(input: StartSession, rpc: Rpc) {
    this.input = input; this.rpc = rpc;
    this.model = input.agent.model.replace(/^GPT-/i, "gpt-").replace(/\s+/g, "-").toLowerCase();
    this.effort = input.agent.effort;
    this.planning = input.agent.permissionMode === "plan";
    this.allow = [...input.agent.alwaysAllow];
    rpc.notifications.push((method, params) => { try { this.notification(method, params); } catch (e) { this.fail(e); } });
    rpc.requests.push((id, method, params) => {
      void this.serverRequest(id, method, params).catch((e) => {
        try { rpc.reject(id, (e as Error).message, -32602); } catch {}
        this.fail(e);
      });
    });
    void rpc.exited.then((code) => { if (!this.stopped) this.fail(new Error(`Codex app-server exited (${code})`)); });
  }

  static async start(input: StartSession, rpc: Rpc): Promise<CodexSession> {
    const session = new CodexSession(input, rpc);
    try { await session.initialize(); return session; }
    catch (e) { await session.stop(); throw e; }
  }

  private emit(event: Record<string, unknown>) { this.events.push(RunEvent.parse({ ...event, runId: this.input.runId })); }
  private fail(error: unknown) {
    if (this.stopped) return;
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error), fatal: true });
    void this.stop();
  }
  private get autoApprove() { return this.input.agent.permissionMode === "auto"; }
  private get approvalPolicy() { return this.planning || this.autoApprove ? "never" : "untrusted"; }
  private get sandboxPolicy() {
    return this.planning ? { type: "readOnly", networkAccess: false } : this.autoApprove ? { type: "dangerFullAccess" } : {
      type: "workspaceWrite", writableRoots: [this.input.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
  }

  private async initialize() {
    await this.rpc.request("initialize", { clientInfo: { name: "beam", title: "Beam", version: "0.0.5" }, capabilities: { experimentalApi: true } });
    this.rpc.notify("initialized");
    // Resolve Beam's display labels and its generic "max" effort against this CLI's catalog.
    let cursor: string | null = null;
    do {
      const page = Models.parse(await this.rpc.request("model/list", { cursor, limit: 100 }));
      const model = page.data.find((m) => m.model === this.model || m.id === this.model || m.displayName.toLowerCase() === this.input.agent.model.toLowerCase());
      if (model) {
        this.model = model.model;
        const supported = model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
        if (this.effort === "max" && !supported.includes("max")) this.effort = ["ultra", "xhigh", "high", "medium", "low"].find((e) => supported.includes(e)) ?? "high";
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const params = {
      model: this.model, cwd: this.input.cwd, approvalPolicy: this.approvalPolicy, approvalsReviewer: "user",
      sandbox: this.planning ? "read-only" : this.autoApprove ? "danger-full-access" : "workspace-write", developerInstructions: this.input.systemContext,
    };
    const dynamicTools=this.input.tools.map(t=>({type:"function",name:t.name,description:t.description,inputSchema:zodToJsonSchema(z.object(t.schema),{$refStrategy:"none"})}));
    this.toolsHash=createHash("sha256").update(JSON.stringify(dynamicTools)).digest("hex");
    const resume = z.object({ threadId: z.string(), toolsHash:z.string().optional() }).safeParse(this.input.resumeCursor);
    // Resumed Codex threads retain their original tool schemas. Start a fresh session with
    // Beam's chat context when tools change, rather than leaving old chats on stale capabilities.
    const compatible=resume.success&&(resume.data.toolsHash===this.toolsHash||(!resume.data.toolsHash&&!dynamicTools.length));
    const result = compatible
      ? await this.rpc.request("thread/resume", { ...params, threadId: resume.data.threadId })
      : await this.rpc.request("thread/start", { ...params, developerInstructions:this.input.fallbackSystemContext??params.developerInstructions, dynamicTools });
    this.threadId = Thread.parse(result).thread.id;
    this.emit({ type: "session.started", resumeCursor: this.resumeCursor() });
  }

  async send(text: string, messageId: string) {
    if (this.stopped || this.interrupted) return;
    if (this.logicalTurn || this.starting || this.queue.length) this.emit({ type: "steer.received", messageId });
    this.queue.push({ text, messageId });
    void this.drain();
  }

  // Beam counts one completion per send. Queue at turn boundaries rather than using
  // turn/steer, which appends to one turn and would leave the runner waiting forever.
  private async drain() {
    if (this.stopped || this.interrupted || this.starting || this.logicalTurn) return;
    const next = this.queue.shift();
    if (next) await this.startTurn(next.text, next.messageId);
  }
  private async startTurn(text: string, messageId?: string) {
    this.starting = true;
    try {
      const result = z.object({ turn: Turn }).parse(await this.rpc.request("turn/start", {
        threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }],
        ...(messageId ? { clientUserMessageId: messageId } : {}),
        model: this.model, effort: this.effort, approvalPolicy: this.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: this.sandboxPolicy,
        collaborationMode: { mode: this.planning ? "plan" : "default", settings: { model: this.model, reasoning_effort: this.effort, developer_instructions: null } },
      }));
      // turn/started normally arrives first. Do not resurrect a turn which already completed.
      if (!this.turnId && !this.logicalTurn && !this.completedTurns.has(result.turn.id) && result.turn.status === "inProgress") this.beginTurn(result.turn.id);
    } catch (e) { this.fail(e); }
    finally { this.starting = false; void this.drain(); }
  }
  private beginTurn(id: string) {
    this.turnId = id;
    if (this.logicalTurn) return; // approved plan continues the same Beam turn
    this.logicalTurn = id;
    this.texts.clear(); this.items.clear();
    this.emit({ type: "turn.started", turnId: id });
  }
  private finishTurn() {
    if (!this.logicalTurn) return;
    this.clearRequests();
    this.emit({ type: "turn.completed", turnId: this.logicalTurn });
    this.logicalTurn = null; this.turnId = null;
    void this.drain();
  }

  private text(itemId: string, text: string, final: boolean) {
    if (!this.logicalTurn) return;
    const before = [...this.texts.values()].join("\n\n");
    this.texts.set(itemId, text);
    const after = [...this.texts.values()].join("\n\n");
    // Beam renders one message and activity panel per turn, not per Codex item.
    if (!final && after.startsWith(before)) this.emit({ type: "content.delta", messageId: this.logicalTurn, delta: after.slice(before.length) });
    else this.emit({ type: "content.final", messageId: this.logicalTurn, text: after });
  }

  private notification(method: string, raw: unknown) {
    if (this.stopped) return;
    const p = Envelope.parse(raw);
    if (p.threadId && p.threadId !== this.threadId) return;
    if (method === "turn/started") { this.beginTurn(Turn.parse(p.turn).id); return; }
    if (method === "turn/completed") {
      const turn = Turn.parse(p.turn);
      if (turn.id !== this.turnId) return;
      this.completedTurns.add(turn.id);
      this.turnId = null;
      if (turn.status === "failed") { this.fail(new Error(turn.error?.message ?? "Codex turn failed")); return; }
      if (this.planning && turn.status === "completed" && !this.interrupted) {
        const requestId = `plan:${turn.id}`;
        this.open(requestId, null, "approval", "Approve the plan and start making changes?", ["allow", "deny"], async (decision) => {
          if (decision !== "allow") { this.finishTurn(); return; }
          this.planning = false;
          await this.startTurn("The team approved the plan. Implement it now.");
        });
      } else this.finishTurn();
      return;
    }
    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const { itemId, delta } = z.object({ itemId: z.string(), delta: z.string() }).parse(p);
      this.text(itemId, (this.texts.get(itemId) ?? "") + delta, false); return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = Item.parse(p.item);
      this.items.set(item.id, item);
      if (item.type === "agentMessage" || item.type === "plan") {
        if (method === "item/completed") this.text(item.id, item.text ?? this.texts.get(item.id) ?? "", true);
        return;
      }
      if (["userMessage", "reasoning", "hookPrompt", "functionCallOutput"].includes(item.type)) return;
      const kind = ({ commandExecution: "bash", fileChange: "edit", dynamicToolCall: "beam", mcpToolCall: "tool", webSearch: "web", collabAgentToolCall: "agent", contextCompaction: "plan" } as Record<string, string>)[item.type] ?? "tool";
      const summary = item.command ?? item.changes?.map((c) => c.path).join(", ") ?? item.tool ?? item.query ?? item.type;
      if (method === "item/started") this.emit({ type: "item.started", itemId: item.id, kind, summary });
      else this.emit({ type: "item.completed", itemId: item.id, summary, detail: truncate(item.aggregatedOutput ?? item.changes?.map((c) => c.diff).join("\n") ?? "") || null, ok: !["failed", "declined", "cancelled"].includes(item.status ?? "") && item.success !== false && (item.exitCode == null || item.exitCode === 0), ms: item.durationMs ?? null });
      return;
    }
    if (method === "error") {
      const { error, willRetry } = z.object({ error: z.object({ message: z.string() }), willRetry: z.boolean() }).parse(p);
      if (willRetry) this.emit({ type: "status", message: error.message, until: null });
      else this.fail(new Error(error.message));
    }
    if (method === "serverRequest/resolved") {
      const id = Id.parse(p.requestId);
      for (const [key, value] of this.pending) if (value.rpcId === id) this.resolve(key, "cleared", "codex");
    }
  }

  private open(key: string, rpcId: string | number | null, kind: "approval" | "input", prompt: string, options: string[] | null, answer: Pending["answer"]) {
    this.pending.set(key, { rpcId, answer });
    this.emit({ type: "request.opened", requestId: key, kind, prompt, options });
  }
  private resolve(key: string, decision: string, by: string) {
    this.pending.delete(key);
    this.emit({ type: "request.resolved", requestId: key, decision, by });
  }
  private clearRequests() { for (const key of this.pending.keys()) this.resolve(key, "cancel", "codex"); }

  private async serverRequest(id: string | number, method: string, raw: unknown) {
    if (this.stopped) return;
    const p = Envelope.parse(raw);
    if (p.threadId !== this.threadId) { this.rpc.reject(id, "Request belongs to another thread"); return; }
    const key = `rpc:${typeof id}:${id}`;
    if (method === "item/tool/call") {
      let text: string, success = false;
      try {
        const call = z.object({ tool: z.string(), arguments: z.unknown() }).parse(p);
        const tool = this.input.tools.find((t) => t.name === call.tool);
        if (!tool) throw new Error(`Unknown Beam tool: ${call.tool}`);
        if (this.planning && tool.name !== "list_repos") throw new Error("Approve the plan before changing the thread's repos or PRs.");
        text = await tool.run(z.object(tool.schema).parse(call.arguments)); success = true;
      } catch (e) { text = `Error: ${(e as Error).message}`; }
      if (!this.stopped) this.rpc.respond(id, { contentItems: [{ type: "inputText", text }], success });
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const a = Approval.parse(p), command = a.command ?? "";
      const name = method.includes("commandExecution") ? "Bash" : "Edit";
      const changes = typeof p.itemId === "string" ? this.items.get(p.itemId)?.changes : undefined;
      const offered = (value: string) => !a.availableDecisions || a.availableDecisions.includes(value);
      if (this.planning) { this.rpc.respond(id, { decision: "decline" }); return; }
      // Full access normally prevents these requests; also settle any the CLI still sends.
      if (this.autoApprove) {
        const decision = ["accept", "acceptForSession"].find(offered);
        if (!decision) throw new Error("Codex offered no supported approval decision in auto mode.");
        this.rpc.respond(id, { decision }); return;
      }
      const allowed = name === "Bash" && command && matchesAllow(name, { command }, this.allow);
      // Allow-list rules do not grant broader filesystem/network access.
      const outside = changes?.some((c) => { const path = relative(this.input.cwd, c.path); return path === ".." || path.startsWith("../") || isAbsolute(path); });
      const broader = !!p.additionalPermissions || !!p.networkApprovalContext || !!a.grantRoot || !!outside;
      if (!broader && offered("accept") && (allowed || (name === "Edit" && this.input.agent.permissionMode !== "ask"))) { this.rpc.respond(id, { decision: "accept" }); return; }
      const options = [...(offered("accept") ? ["allow"] : []), ...(offered("acceptForSession") ? ["always"] : []), "deny"];
      const prompt = [name === "Bash" ? `Run: ${command || "command"}` : `Allow file changes?${changes?.length ? "\n" + changes.map((c) => `${c.path}\n${truncate(c.diff)}`).join("\n") : ""}`, a.reason, a.grantRoot ? `Root: ${a.grantRoot}` : "", p.additionalPermissions || p.networkApprovalContext ? JSON.stringify({ permissions: p.additionalPermissions, network: p.networkApprovalContext }) : ""].filter(Boolean).join("\n");
      this.open(key, id, "approval", prompt, options, (decision) => {
        const mapped = decision === "allow" ? "accept" : decision === "always" ? "acceptForSession" : "decline";
        this.rpc.respond(id, { decision: offered(mapped) ? mapped : "cancel" });
      }); return;
    }
    if (method === "item/tool/requestUserInput") {
      const { questions } = z.object({ questions: z.array(Question) }).parse(p);
      // Beam chats are shared records: never solicit secrets into them.
      if (questions.some((q) => q.isSecret)) { this.rpc.respond(id, { answers: {} }); this.emit({ type: "error", message: "Codex requested secret input; enter credentials in its CLI instead of the shared chat.", fatal: false }); return; }
      if (!questions.length) { this.rpc.respond(id, { answers: {} }); return; }
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) this.open(`${key}:${q.id}`, id, "input", q.question + (q.options?.length ? "\n" + q.options.map((o) => `${o.label}: ${o.description}`).join("\n") : ""), q.options?.map((o) => o.label) ?? null, (decision) => {
        answers[q.id] = { answers: [decision] };
        if (Object.keys(answers).length === questions.length) this.rpc.respond(id, { answers });
      }); return;
    }
    if (method === "item/permissions/requestApproval") {
      const permissions = z.record(z.unknown()).parse(p.permissions);
      if (this.planning) { this.rpc.respond(id, { permissions: {}, scope: "turn" }); return; }
      if (this.autoApprove) { this.rpc.respond(id, { permissions: Object.fromEntries(Object.entries(permissions).filter(([, v]) => v != null)), scope: "turn" }); return; }
      this.open(key, id, "approval", `${typeof p.reason === "string" ? p.reason : "Allow additional permissions?"}\n${JSON.stringify(permissions)}`, ["allow", "deny"], (decision) => {
        this.rpc.respond(id, { permissions: decision === "allow" ? Object.fromEntries(Object.entries(permissions).filter(([, v]) => v != null)) : {}, scope: "turn" });
      }); return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.rpc.respond(id, { action: "decline", content: null });
      this.emit({ type: "error", message: "An MCP server requested a form or browser sign-in that Beam cannot display. The request was declined; complete setup in the Codex CLI.", fatal: false });
      return;
    }
    // An unsupported server request must get an error, never hang the harness.
    this.rpc.reject(id, `Beam does not support ${method}`);
  }

  async respond(requestId: string, decision: string, by = "beam") {
    const pending = this.pending.get(requestId);
    if (!pending || this.stopped) return;
    this.resolve(requestId, decision, by);
    try { await pending.answer(decision); } catch (e) { this.fail(e); }
  }
  async interrupt() {
    this.interrupted = true; this.queue.length = 0;
    if (this.turnId) await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    else this.finishTurn();
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.queue.length = 0;
    this.clearRequests(); this.rpc.kill(); this.events.close();
    // Give the process time to exit before the runner commits its worktree.
    this.stopping = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      void this.rpc.exited.then(() => { clearTimeout(timeout); resolve(); });
    });
    return this.stopping;
  }
  resumeCursor() { return this.threadId ? { threadId: this.threadId, toolsHash:this.toolsHash } : null; }
}
