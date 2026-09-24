import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { isLive } from "./runs";
import { startRun } from "./messages";
import { SYSTEM } from "./routerPrompt";
import { askJev } from "../packages/contracts/src/jev";

/**
 * The router: a small, fast model reads each plain message in a team chat and decides whether one of the
 * chat's agents should act on it, so people do not have to @mention every time. Explicit mentions never
 * pass through here. Runs as a scheduled action right after the message is written.
 *
 *   Provider is picked from whichever key is set (Convex env), in this order:
 *   OPENROUTER_API_KEY  → openai/gpt-5.4-mini via OpenRouter, hedged by google/gemini-3.5-flash-lite after
 *                         ROUTER_HEDGE_MS (1000): measured 36/36 on scripts/router-bench.mjs at ~550ms median but
 *                         with a 4-5s tail; the hedge caps that. ROUTER_MODEL / ROUTER_HEDGE_MODEL override.
 *   GEMINI_API_KEY      → Gemini 3.8 Flash, thinking minimal (best intelligence at ~0.7s first token)
 *   ANTHROPIC_API_KEY   → Claude Haiku 4.5
 *   OPENAI_API_KEY      → GPT-5.6 Luna
 *   ROUTER_PROVIDER     force one of openrouter | gemini | anthropic | openai
 *   ROUTER_MODEL        override the model id
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
    const chat = await ctx.db.get(m.chatId);
    if (!chat || chat.state === "deleted") return null;
    const all = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    const agents = (chat.agents ? all.filter((a) => chat.agents!.includes(a._id)) : all).map((a) => ({ handle: a.handle, name: HARNESS_NAME[a.harness] ?? a.harness, model: a.model }));
    if (!agents.length) return null;
    const msgs = await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", m.chatId)).collect();
    const idx = msgs.findIndex((x) => x._id === messageId);
    const recent = msgs.slice(Math.max(0, idx - 14), idx);
    const who = (author: string) => { if (!author.startsWith("agent:")) return author; const a = all.find((x) => `agent:${x._id}` === author); return a ? `@${a.handle} (agent)` : "agent"; };
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", m.chatId)).collect();
    const live = runs.find((r) => isLive(r.state) && r.dispatchedBy === m.author);
    const liveHandle = live ? all.find((a) => a._id === live.agentId)?.handle ?? null : null;
    return {
      title: chat.title, repo: chat.repo, agents, liveHandle,
      transcript: recent.map((x) => ({ who: who(x.author), text: x.text.slice(0, 600), kind: x.kind })),
      message: { who: m.author, text: m.text },
    };
  },
});



type Provider = "openrouter" | "gemini" | "anthropic" | "openai";
const DEFAULT_MODEL: Record<Provider, string> = { openrouter: "openai/gpt-5.4-mini", gemini: "gemini-3.8-flash", anthropic: "claude-haiku-4-5-20251001", openai: "gpt-5.4-mini" };
const DEFAULT_HEDGE = "google/gemini-3.5-flash-lite";

function renderUser(c: RouterContext): string {
  const lines = c.transcript.map((t) => `${t.who}: ${t.text}`).join("\n");
  return [
    `Chat: "${c.title}"${c.repo ? ` · repo ${c.repo}` : " · no repo attached"}`,
    `Agents in this chat: ${c.agents.map((a) => `@${a.handle} (${a.name}, ${a.model})`).join(", ")}`,
    c.liveHandle ? `Currently running: @${c.liveHandle}` : "No agent is running.",
    ``, `Chat so far:`, lines || "(nothing yet)", ``, `NEWEST: ${c.message.who}: ${c.message.text}`,
  ].join("\n");
}

function parseDecision(text: string, c: RouterContext): { agent: string | null; why: string } {
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text) as { agent?: string | null; why?: string };
  const agent = typeof parsed.agent === "string" ? parsed.agent.replace(/^@/, "").toLowerCase() : null;
  return { agent: agent && c.agents.some((a) => a.handle === agent) ? agent : null, why: String(parsed.why ?? "").slice(0, 80) };
}

async function askGemini(key: string, model: string, c: RouterContext) {
  const body = (thinking: boolean) => JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: renderUser(c) }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 120, responseMimeType: "application/json", ...(thinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}) },
  });
  const call = (thinking: boolean) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: body(thinking) });
  let res = await call(true);
  if (res.status === 400) res = await call(false); // older Flash models reject thinkingLevel
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return parseDecision(data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "", c);
}

async function askAnthropic(key: string, model: string, c: RouterContext) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 80, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: renderUser(c) }, { role: "assistant", content: "{" }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return parseDecision("{" + (data.content.find((b) => b.type === "text")?.text ?? ""), c);
}

async function askOpenAI(key: string, model: string, c: RouterContext) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_completion_tokens: 120, reasoning_effort: "minimal", response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: renderUser(c) }] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseDecision(data.choices[0]?.message.content ?? "", c);
}

/** OpenAI-compatible. `reasoning.effort` is OpenRouter's unified knob; retried without it if a model rejects it. */
async function askOpenRouter(key: string, model: string, c: RouterContext) {
  const body = (reasoning: boolean) => JSON.stringify({
    model, max_tokens: 400, temperature: 0, response_format: { type: "json_object" },
    ...(reasoning ? { reasoning: { effort: "minimal" } } : {}),
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: renderUser(c) }],
  });
  const call = (reasoning: boolean) => fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "HTTP-Referer": "https://beam.supraluminal.dev", "X-Title": "Beam" },
    body: body(reasoning),
  });
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseDecision(data.choices[0]?.message.content ?? "", c);
}

/** Primary model, and after hedgeMs a second model in parallel; first good answer wins. */
async function askOpenRouterHedged(key: string, model: string, c: RouterContext) {
  const hedgeModel = process.env["ROUTER_HEDGE_MODEL"] ?? DEFAULT_HEDGE;
  const hedgeMs = Number(process.env["ROUTER_HEDGE_MS"] ?? 1000);
  if (!hedgeModel || hedgeModel === "none" || hedgeModel === model) return askOpenRouter(key, model, c);
  const tag = (m: string, p: Promise<{ agent: string | null; why: string }>) => p.then((d) => ({ ...d, model: m }));
  const primary = tag(model, askOpenRouter(key, model, c));
  const timer = new Promise<"hedge">((res) => setTimeout(() => res("hedge"), hedgeMs));
  const first = await Promise.race([primary.catch(() => "failed" as const), timer]);
  if (first !== "hedge" && first !== "failed") return first;
  const hedge = tag(hedgeModel, askOpenRouter(key, hedgeModel, c));
  return Promise.any([primary, hedge]);
}

function pickProvider(): { provider: Provider; key: string } | null {
  const forced = process.env["ROUTER_PROVIDER"] as Provider | undefined;
  const keys: Record<Provider, string | undefined> = { openrouter: process.env["OPENROUTER_API_KEY"], gemini: process.env["GEMINI_API_KEY"], anthropic: process.env["ANTHROPIC_API_KEY"], openai: process.env["OPENAI_API_KEY"] };
  if (forced && keys[forced]) return { provider: forced, key: keys[forced]! };
  for (const p of ["openrouter", "gemini", "anthropic", "openai"] as Provider[]) if (keys[p]) return { provider: p, key: keys[p]! };
  return null;
}

export const classify = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const c = await ctx.runQuery(internal.router.context, { messageId });
    if (!c) return;
    const stub = process.env["ROUTER_STUB"];
    const pick = pickProvider();
    let decision: { agent: string | null; why: string };
    if (stub) decision = { agent: stub === "none" ? null : stub, why: "stub" };
    else if (!pick) { console.log("router: no OPENROUTER_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY set, skipping"); return; }
    else {
      const model = process.env["ROUTER_MODEL"] ?? DEFAULT_MODEL[pick.provider];
      const t0 = Date.now();
      const ask = { openrouter: askOpenRouterHedged, gemini: askGemini, anthropic: askAnthropic, openai: askOpenAI }[pick.provider];
      try { decision = await ask(pick.key, model, c); }
      catch (e) { console.error("router failed", (e as Error).message); return; }
      console.log(`router ${messageId}: ${pick.provider}/${(decision as { model?: string }).model ?? model} → ${decision.agent ?? "none"} (${decision.why}) in ${Date.now() - t0}ms`);
    }
    await ctx.runMutation(internal.router.apply, { messageId, agent: decision.agent, why: decision.why });
    // Schedule only after applying the real decision; shadow failures never block dispatch.
    if (process.env["JEV_SHADOW"] === "true" && process.env["JEV_API_KEY"]) {
      try { await ctx.scheduler.runAfter(0, internal.router.shadow, { messageId, snapshot: c }); }
      catch { console.warn("Could not schedule Jev shadow evaluation"); }
    }
  },
});

/** Turn a routed plain message into a dispatch or a steer. Nothing happens if someone already mentioned an agent meanwhile. */
export const apply = internalMutation({
  args: { messageId: v.id("messages"), agent: v.union(v.string(), v.null()), why: v.string() },
  handler: async (ctx, { messageId, agent, why }) => {
    const m = await ctx.db.get(messageId);
    if (!m || m.kind !== "text") return;
    if (!agent) { await ctx.db.patch(messageId, { routed: { agent: null, why } }); return; }
    const chat = await ctx.db.get(m.chatId);
    if (!chat || chat.state === "deleted") return;
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect();
    const a = agents.find((x) => x.handle === agent && (!chat.agents || chat.agents.includes(x._id)));
    if (!a) { await ctx.db.patch(messageId, { routed: { agent: null, why: `no agent @${agent}` } }); return; }
    const runs = await ctx.db.query("runs").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect();
    const live = runs.find((r) => isLive(r.state) && r.agentId === a._id && r.dispatchedBy === m.author);
    if (live) { await ctx.db.patch(messageId, { kind: "steer", runId: live._id, routed: { agent, why } }); return; }
    try {
      await startRun(ctx, chat, a, messageId, m.author);
      await ctx.db.patch(messageId, { kind: "dispatch", routed: { agent, why } });
    } catch (e) {
      await ctx.db.patch(messageId, { routed: { agent: null, why: "Could not start agent", error: (e as Error).message.slice(0, 300) } });
    }
  },
});

/** Experiment only: never calls apply/startRun. No chat content or credentials are logged. */
export const shadow = internalAction({
  args: { messageId: v.id("messages"), snapshot: v.object({ title: v.string(), repo: v.union(v.string(), v.null()), agents: v.array(v.object({ handle: v.string(), name: v.string(), model: v.string() })), liveHandle: v.union(v.string(), v.null()), transcript: v.array(v.object({ who: v.string(), text: v.string(), kind: v.string() })), message: v.object({ who: v.string(), text: v.string() }) }) },
  handler: async (_ctx, { messageId, snapshot: c }) => {
    const key = process.env["JEV_API_KEY"];
    if (!key || process.env["JEV_SHADOW"] !== "true") return;
    const started = Date.now();
    try {
      const decision = await askJev(key, c, SYSTEM, { model: process.env["JEV_MODEL"] ?? "jev-latest", threshold: Number(process.env["JEV_THRESHOLD"] ?? 0.9) });
      console.log("router shadow", JSON.stringify({ messageId, ...decision, ms: Date.now() - started }));
    } catch (error) { console.warn("router shadow failed", (error as Error).message); }
  },
});
