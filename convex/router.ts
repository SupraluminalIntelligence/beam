import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { isLive } from "./runs";
import { startRun } from "./messages";

/**
 * The router: a small, fast model reads each plain message in a team chat and decides whether one of the
 * chat's agents should act on it, so people do not have to @mention every time. Explicit mentions never
 * pass through here. Runs as a scheduled action right after the message is written.
 *
 *   ANTHROPIC_API_KEY   required (Convex env)
 *   ROUTER_MODEL        default claude-haiku-4-5-20251001
 *   ROUTER_STUB         tests only: a handle to always pick, or "none"
 */
declare const process: { env: Record<string, string | undefined> };

interface RouterContext {
  title: string; repo: string | null;
  agents: { handle: string; name: string; model: string }[];
  liveHandle: string | null;
  transcript: { who: string; text: string; kind: string }[];
  message: { who: string; text: string };
}

const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };

export const context = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<RouterContext | null> => {
    const m = await ctx.db.get(messageId);
    if (!m || m.kind !== "text") return null;
    const chat = (await ctx.db.get(m.chatId))!;
    const all = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    const agents = (chat.agents ? all.filter((a) => chat.agents!.includes(a._id)) : all).map((a) => ({ handle: a.handle, name: HARNESS_NAME[a.harness] ?? a.harness, model: a.model }));
    if (!agents.length) return null;
    const msgs = await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", m.chatId)).collect();
    const idx = msgs.findIndex((x) => x._id === messageId);
    const recent = msgs.slice(Math.max(0, idx - 14), idx);
    const who = (author: string) => { if (!author.startsWith("agent:")) return author; const a = all.find((x) => `agent:${x._id}` === author); return a ? `@${a.handle} (agent)` : "agent"; };
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", m.chatId)).collect();
    const live = runs.find((r) => isLive(r.state));
    const liveHandle = live ? all.find((a) => a._id === live.agentId)?.handle ?? null : null;
    return {
      title: chat.title, repo: chat.repo, agents, liveHandle,
      transcript: recent.map((x) => ({ who: who(x.author), text: x.text.slice(0, 600), kind: x.kind })),
      message: { who: m.author, text: m.text },
    };
  },
});

const SYSTEM = `You route messages in a team chat where people and coding agents work together. Agents can read and edit the chat's repo, run commands, and answer technical questions. Given the chat so far and the NEWEST message, decide whether an agent should act on the newest message right now, and which one.

Invoke an agent when the newest message:
- asks for work, a change, a check, or an investigation an agent could do
- asks a question that needs the code or the repo to answer
- answers or follows up on something an agent just said or asked (e.g. "yes do that", "use the second option", "why did you change X?")
- is clearly addressed to an agent even without a mention

Do NOT invoke when the newest message:
- is people talking to each other, coordinating, joking, or acknowledging ("nice", "ok", "lol", "thanks")
- is addressed to a named person, or asks something only a person can answer (opinions, schedules, decisions)
- is thinking out loud without asking for anything yet
- would only repeat what an agent is already doing

If several agents are in the chat, pick the one the conversation is with (the one last active, or the one whose name is implied); otherwise the first listed. If an agent is currently running, invoking it delivers the message as a steer to that run; do that only if the message is for it.

Reply with JSON only, no prose: {"agent": "<handle>" | null, "why": "<at most 8 words>"}`;

async function ask(key: string, model: string, c: RouterContext): Promise<{ agent: string | null; why: string }> {
  const lines = c.transcript.map((t) => `${t.who}: ${t.text}`).join("\n");
  const user = [
    `Chat: "${c.title}"${c.repo ? ` · repo ${c.repo}` : " · no repo attached"}`,
    `Agents in this chat: ${c.agents.map((a) => `@${a.handle} (${a.name}, ${a.model})`).join(", ")}`,
    c.liveHandle ? `Currently running: @${c.liveHandle}` : "No agent is running.",
    ``, `Chat so far:`, lines || "(nothing yet)", ``, `NEWEST: ${c.message.who}: ${c.message.text}`,
  ].join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 80, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: user }, { role: "assistant", content: "{" }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = "{" + (data.content.find((b) => b.type === "text")?.text ?? "");
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text) as { agent?: string | null; why?: string };
  const agent = typeof parsed.agent === "string" ? parsed.agent.replace(/^@/, "").toLowerCase() : null;
  return { agent: agent && c.agents.some((a) => a.handle === agent) ? agent : null, why: String(parsed.why ?? "").slice(0, 80) };
}

export const classify = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const c = await ctx.runQuery(internal.router.context, { messageId });
    if (!c) return;
    const stub = process.env["ROUTER_STUB"];
    const key = process.env["ANTHROPIC_API_KEY"];
    let decision: { agent: string | null; why: string };
    if (stub) decision = { agent: stub === "none" ? null : stub, why: "stub" };
    else if (!key) { console.log("router: ANTHROPIC_API_KEY not set, skipping"); return; }
    else {
      try { decision = await ask(key, process.env["ROUTER_MODEL"] ?? "claude-haiku-4-5-20251001", c); }
      catch (e) { console.error("router failed", (e as Error).message); return; }
    }
    await ctx.runMutation(internal.router.apply, { messageId, agent: decision.agent, why: decision.why });
  },
});

/** Turn a routed plain message into a dispatch or a steer. Nothing happens if someone already mentioned an agent meanwhile. */
export const apply = internalMutation({
  args: { messageId: v.id("messages"), agent: v.union(v.string(), v.null()), why: v.string() },
  handler: async (ctx, { messageId, agent, why }) => {
    const m = await ctx.db.get(messageId);
    if (!m || m.kind !== "text") return;
    if (!agent) { await ctx.db.patch(messageId, { routed: { agent: null, why } }); return; }
    const chat = (await ctx.db.get(m.chatId))!;
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    const a = agents.find((x) => x.handle === agent && (!chat.agents || chat.agents.includes(x._id)));
    if (!a) { await ctx.db.patch(messageId, { routed: { agent: null, why: `no agent @${agent}` } }); return; }
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect();
    const live = runs.find((r) => isLive(r.state));
    if (live && live.agentId === a._id) { await ctx.db.patch(messageId, { kind: "steer", runId: live._id, routed: { agent, why } }); return; }
    if (live) { await ctx.db.patch(messageId, { routed: { agent: null, why: "another agent is running" } }); return; }
    try {
      await startRun(ctx, chat, a, messageId, m.author);
      await ctx.db.patch(messageId, { kind: "dispatch", routed: { agent, why } });
    } catch (e) {
      await ctx.db.patch(messageId, { routed: { agent: null, why: (e as Error).message.slice(0, 80) } });
    }
  },
});
