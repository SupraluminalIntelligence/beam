import type { HarnessStatus, RunEvent } from "@beam/contracts";
import { createSdkMcpServer, query, tool, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";
import { AsyncQueue } from "../queue.ts";
import { describeTool, matchesAllow, truncate } from "../tools.ts";
import { cliVersion, withTimeout } from "../version.ts";

/**
 * Claude Code via the Agent SDK. The probe opens a query whose prompt never yields,
 * reads initializationResult().account, and closes. No message is sent, no tokens spent,
 * and Beam never logs in for the user: the CLI finds its own credentials.
 */
const PLAN: Record<string, string> = {
  claudemaxsubscription: "Max", claudemax5xsubscription: "Max 5x", claudemax20xsubscription: "Max 20x",
  claudeprosubscription: "Pro", claudeteamsubscription: "Team", claudeenterprisesubscription: "Enterprise", claudefreesubscription: "Free",
  max: "Max", max5: "Max 5x", max20: "Max 20x", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free",
};
const planLabel = (s: string | undefined) => (s ? PLAN[s.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? s : null);

/** Beam's display names → model ids. Unknown names pass through untouched. */
const MODEL_IDS: Record<string, string> = { "Fable 5.1": "claude-fable-5-1", "Fable 5.0": "claude-fable-5", "Opus 5.0": "claude-opus-5", "Sonnet 5.0": "claude-sonnet-5" };
export const claudeModelId = (name: string) => MODEL_IDS[name] ?? name;

const baseEnv = () => ({ ...process.env, CLAUDE_CODE_AUTO_CONNECT_IDE: "0" }) as Record<string, string>;

async function* never(): AsyncGenerator<never> { await new Promise(() => {}); }

export async function probeClaude(): Promise<HarnessStatus> {
  const base = { harness: "claude" as const, probedAt: Date.now(), plan: null, email: null };
  const bin = await which("claude");
  if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "Claude Code (`claude`) is not on PATH. Install it, then run `claude auth login`." };
  const version = await cliVersion(bin);
  let q: ReturnType<typeof query> | null = null;
  try {
    q = query({
      prompt: never() as AsyncIterable<never>,
      options: { cwd: tmpdir(), persistSession: false, allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], env: baseEnv(), pathToClaudeCodeExecutable: bin },
    });
    const init = await withTimeout(q.initializationResult(), 25_000, "claude init");
    const acct = init.account ?? {};
    const provider = acct.apiProvider;
    if (provider && provider !== "firstParty") return { ...base, installed: true, version, auth: "authenticated", plan: provider, message: `Authenticated via ${provider}` };
    const src = (acct.tokenSource ?? "").toLowerCase();
    const apiKey = src.includes("apikey") || src.includes("authtoken");
    if (apiKey) return { ...base, installed: true, version, auth: "authenticated", plan: "API key", email: acct.email ?? null, message: null };
    if (acct.email || acct.subscriptionType) return { ...base, installed: true, version, auth: "authenticated", plan: planLabel(acct.subscriptionType), email: acct.email ?? null, message: null };
    return { ...base, installed: true, version, auth: "unauthenticated", message: "Not signed in. Run `claude auth login`." };
  } catch (e) {
    return { ...base, installed: true, version, auth: "unknown", message: `Could not verify sign-in: ${(e as Error).message}` };
  } finally {
    try { q?.close(); } catch {}
  }
}

/**
 * A live Claude Code session in the chat's worktree. Streaming input: every send() is a user turn,
 * and sends that arrive while a turn is running queue as the next turn (that is Beam's "steer").
 * Permission prompts become request.opened events and block until someone in the chat answers.
 */
class ClaudeSession implements Session {
  readonly events = new AsyncQueue<RunEvent>();
  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly q: Query;
  private readonly pending = new Map<string, (decision: string) => void>();
  private readonly allow: string[];
  private readonly toolStart = new Map<string, number>();
  private sessionId: string | null;
  private turn = 0;
  private text = "";
  private stopped = false;
  private readonly input: StartSession;

  /** `bin` is the user's installed `claude`; the SDK's own copy is not shipped inside the packaged app. */
  constructor(input: StartSession, bin: string) {
    this.input = input;
    const { agent, cwd, resumeCursor } = input;
    this.allow = [...agent.alwaysAllow];
    this.sessionId = (resumeCursor as { sessionId?: string } | null)?.sessionId ?? null;
    // Beam mode → Claude Code mode. "auto" is Claude Code's classifier-approved mode, not bypass: the chat still sees
    // (and can answer) whatever the classifier will not approve on its own.
    const permissionMode: PermissionMode = ({ ask: "default", plan: "plan", auto: "auto", allowlist: "acceptEdits" } as Record<string, PermissionMode>)[agent.permissionMode] ?? "default";
    const beam = createSdkMcpServer({
      name: "beam",
      tools: input.tools.map((t) => tool(t.name, t.description, t.schema, async (args) => {
        try { return { content: [{ type: "text", text: await t.run(args as Record<string, unknown>) }] }; }
        catch (e) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
      }, { alwaysLoad: true })),
    });
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd,
        model: claudeModelId(agent.model),
        effort: agent.effort,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        canUseTool: (name, toolInput, { requestId }) => this.askPermission(name, toolInput as Record<string, unknown>, requestId),
        includePartialMessages: true,
        persistSession: true,
        settingSources: ["user", "project"],
        mcpServers: input.tools.length ? { beam } : {},
        env: baseEnv(),
        pathToClaudeCodeExecutable: bin,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(input.systemContext ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: input.systemContext } } : {}),
      },
    });
    void this.pump();
  }

  private emit(e: RunEvent) { this.events.push(e); }

  private async askPermission(name: string, toolInput: Record<string, unknown>, requestId: string) {
    if (matchesAllow(name, toolInput, this.allow)) return { behavior: "allow" as const, updatedInput: toolInput };
    const { kind, summary } = describeTool(name, toolInput, this.input.cwd);
    const plan = name === "ExitPlanMode";
    this.emit({ type: "request.opened", runId: this.input.runId as never, requestId, kind: "approval", prompt: plan ? "Approve the plan and start making changes?" : kind === "bash" ? `Run: ${summary}` : summary, options: plan ? ["allow", "deny"] : ["allow", "always", "deny"] });
    const decision = await new Promise<string>((res) => this.pending.set(requestId, res));
    if (decision === "always") { this.allow.push(name === "Bash" ? String(toolInput["command"] ?? "").split(/\s+/).slice(0, 2).join(" ") : name); }
    if (decision === "allow" || decision === "always") return { behavior: "allow" as const, updatedInput: toolInput };
    return { behavior: "deny" as const, message: `Denied in Beam by a member of the chat. Do not retry this call; explain what you would have done instead.` };
  }

  private async pump() {
    const runId = this.input.runId as never;
    try {
      for await (const m of this.q) this.handle(m as SDKMessage);
    } catch (e) {
      if (!this.stopped) this.emit({ type: "error", runId, message: (e as Error).message, fatal: true });
    } finally {
      this.events.close();
    }
  }

  private handle(m: SDKMessage) {
    const runId = this.input.runId as never;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") { this.sessionId = m.session_id; this.emit({ type: "session.started", runId, resumeCursor: { sessionId: m.session_id } }); }
        return;
      case "stream_event": {
        if (m.parent_tool_use_id) return;
        const ev = m.event as { type: string; delta?: { type: string; text?: string }; content_block?: { type: string } };
        // Text blocks are separated by tool calls; keep them as paragraphs rather than gluing them together.
        if (ev.type === "content_block_start" && ev.content_block?.type === "text" && this.text && !this.text.endsWith("\n\n")) {
          this.text += "\n\n";
          this.emit({ type: "content.delta", runId, messageId: `t${this.turn}` as never, delta: "\n\n" });
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.text += ev.delta.text;
          this.emit({ type: "content.delta", runId, messageId: `t${this.turn}` as never, delta: ev.delta.text });
        }
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        for (const block of m.message.content as { type: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
          if (block.type === "tool_use" && block.id && block.name) {
            const { kind, summary } = describeTool(block.name, block.input ?? {}, this.input.cwd);
            this.toolStart.set(block.id, Date.now());
            this.emit({ type: "item.started", runId, itemId: block.id, kind, summary });
          }
        }
        return;
      }
      case "user": {
        if (m.parent_tool_use_id) return;
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const started = this.toolStart.get(block.tool_use_id);
          const detail = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") : "";
          this.emit({ type: "item.completed", runId, itemId: block.tool_use_id, summary: "", detail: detail ? truncate(detail) : null, ok: !block.is_error, ms: started ? Date.now() - started : null });
        }
        return;
      }
      case "result": {
        const text = this.text.trim() || (m.subtype === "success" ? m.result : "");
        if (text) this.emit({ type: "content.final", runId, messageId: `t${this.turn}` as never, text });
        if (m.subtype !== "success") this.emit({ type: "error", runId, message: `${m.subtype}${"errors" in m && Array.isArray(m.errors) ? ": " + m.errors.join("; ") : ""}`, fatal: false });
        this.emit({ type: "turn.completed", runId, turnId: `turn${this.turn}` });
        this.text = "";
        return;
      }
      default:
        return;
    }
  }

  async send(text: string, messageId: string) {
    this.turn += 1;
    this.text = "";
    this.emit({ type: "turn.started", runId: this.input.runId as never, turnId: `turn${this.turn}` });
    if (this.turn > 1) this.emit({ type: "steer.received", runId: this.input.runId as never, messageId: messageId as never });
    this.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId ?? "" } as unknown as SDKUserMessage);
  }
  async interrupt() { try { await this.q.interrupt(); } catch {} }
  async respond(requestId: string, decision: string) {
    const r = this.pending.get(requestId);
    if (r) { this.pending.delete(requestId); r(decision); }
  }
  async stop() {
    this.stopped = true;
    for (const [id, r] of this.pending) { r("deny"); this.pending.delete(id); }
    this.inbox.close();
    try { this.q.close(); } catch {}
  }
  resumeCursor() { return this.sessionId ? { sessionId: this.sessionId } : null; }
}

export const claudeAdapter: HarnessAdapter = {
  kind: "claude",
  probe: probeClaude,
  async start(input: StartSession): Promise<Session> {
    const bin = await which("claude");
    if (!bin) throw new Error("Claude Code (`claude`) is not on PATH on this runner");
    return new ClaudeSession(input, bin);
  },
};
