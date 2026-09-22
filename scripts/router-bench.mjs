// Real numbers for the router: the same prompt, a fixed set of chat situations with expected decisions,
// every candidate model on OpenRouter. Reports accuracy and wall-clock latency from this machine.
//   OPENROUTER_API_KEY=... node scripts/router-bench.mjs [model ...]
import { SYSTEM } from "../convex/routerPrompt.ts";
import { readFileSync } from "node:fs";

const key = process.env.OPENROUTER_API_KEY ?? readFileSync(".env.local", "utf8").match(/OPENROUTER_API_KEY=(\S+)/)?.[1];
if (!key) { console.error("no OPENROUTER_API_KEY"); process.exit(1); }
const args = process.argv.slice(2).filter((a) => a !== "--hedged");
const MODELS = args.length ? args : [
  "google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.5-flash-lite",
  "anthropic/claude-haiku-4.5", "openai/gpt-5.6-luna", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano",
  "deepseek/deepseek-v4-flash", "google/gemma-4-31b-it",
];

import { cases } from "./router-cases.mjs";

const render = (c) => [
  `Chat: "bench" · repo acme/demo`,
  `Agents in this chat: ${c.agents.map((a) => `@${a.handle} (${a.name}, ${a.model})`).join(", ")}`,
  c.live ? `Currently running: @${c.live}` : "No agent is running.",
  ``, `Chat so far:`, c.t.map((x) => `${x.who}: ${x.text}`).join("\n") || "(nothing yet)", ``, `NEWEST: ${c.m.who}: ${c.m.text}`,
].join("\n");

async function askSingle(model, c) {
  const body = (reasoning) => JSON.stringify({ model, max_tokens: Number(process.env.MAX_TOKENS ?? 120), temperature: 0, response_format: { type: "json_object" }, ...(reasoning ? { reasoning: { effort: "minimal" } } : {}), messages: [{ role: "system", content: SYSTEM }, { role: "user", content: render(c) }] });
  const call = (r) => fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body(r) });
  const t0 = performance.now();
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) return { ms, error: `${res.status} ${(await res.text()).slice(0, 120)}` };
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  try {
    const m = text.match(/\{[\s\S]*\}/); const p = JSON.parse(m ? m[0] : text);
    const agent = typeof p.agent === "string" ? p.agent.replace(/^@/, "").toLowerCase() : null;
    return { ms, agent: agent && c.agents.some((a) => a.handle === agent) ? agent : null, why: p.why, provider: data.provider };
  } catch { return { ms, error: `unparseable: ${text.slice(0, 80)}` }; }
}

async function ask(model, c) {
  if (!process.argv.includes("--hedged")) return askSingle(model, c);
  const started = performance.now();
  const valid = async (m) => { const result = await askSingle(m, c); if (result.error) throw new Error(result.error); return result; };
  const primary = valid(model);
  let timer;
  const first = await Promise.race([primary.catch(() => null), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]);
  clearTimeout(timer);
  if (first) return first;
  try { return { ...await Promise.any([primary, valid("google/gemini-3.5-flash-lite")]), ms: Math.round(performance.now() - started) }; }
  catch { return { error: "both router models failed", ms: Math.round(performance.now() - started) }; }
}

const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
const results = {};
for (const model of MODELS) {
  const rows = [];
  for (let i = 0; i < cases.length; i += 6) rows.push(...(await Promise.all(cases.slice(i, i + 6).map(async (c) => ({ c, r: await ask(model, c) })))));
  const ok = rows.filter(({ c, r }) => !r.error && r.agent === c.want);
  const wrong = rows.filter(({ c, r }) => !r.error && r.agent !== c.want).map(({ c, r }) => `${c.name} → ${r.agent ?? "none"} (${r.why ?? ""})`);
  const errors = rows.filter(({ r }) => r.error).map(({ c, r }) => `${c.name}: ${r.error}`);
  const lat = rows.filter(({ r }) => !r.error).map(({ r }) => r.ms).sort((a, b) => a - b);
  results[model] = { accuracy: `${ok.length}/${cases.length}`, p50ms: q(lat, 0.5) ?? null, p90ms: q(lat, 0.9) ?? null, p95ms: q(lat, 0.95) ?? null, falseActivations: rows.filter(({c,r}) => !r.error && c.want === null && r.agent !== null).length, missedRequests: rows.filter(({c,r}) => !r.error && c.want !== null && r.agent === null).length, maxms: lat[lat.length - 1] ?? null, wrong, errors: errors.slice(0, 3), provider: rows.find(({ r }) => r.provider)?.r.provider ?? null };
  console.error(`${model.padEnd(32)} ${results[model].accuracy}  p50 ${results[model].p50ms}ms  p90 ${results[model].p90ms}ms${errors.length ? `  errors ${errors.length}` : ""}`);
}
console.log(JSON.stringify(results, null, 1));
