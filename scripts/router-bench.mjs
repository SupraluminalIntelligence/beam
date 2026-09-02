// Real numbers for the router: the same prompt, a fixed set of chat situations with expected decisions,
// every candidate model on OpenRouter. Reports accuracy and wall-clock latency from this machine.
//   OPENROUTER_API_KEY=... node scripts/router-bench.mjs [model ...]
import { SYSTEM } from "../convex/routerPrompt.ts";
import { readFileSync } from "node:fs";

const key = process.env.OPENROUTER_API_KEY ?? readFileSync(".env.local", "utf8").match(/OPENROUTER_API_KEY=(\S+)/)?.[1];
if (!key) { console.error("no OPENROUTER_API_KEY"); process.exit(1); }
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
  "google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.5-flash-lite",
  "anthropic/claude-haiku-4.5", "openai/gpt-5.6-luna", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano",
  "deepseek/deepseek-v4-flash", "google/gemma-4-31b-it",
];

const ONE = [{ handle: "claude", name: "Claude Code", model: "Fable 5.1" }];
const TWO = [...ONE, { handle: "codex", name: "Codex", model: "GPT-5.6 Sol" }];
const C = (who, text) => ({ who, text });
const A = (handle, text) => ({ who: `@${handle} (agent)`, text });
const cases = [
  { name: "direct ask", agents: ONE, t: [], m: C("apek", "can someone add a subtract function next to add in src/math.ts?"), want: "claude" },
  { name: "person mention", agents: ONE, t: [], m: C("apek", "@noah are you around for standup?"), want: null },
  { name: "ack after report", agents: ONE, t: [C("apek", "@claude add subtract to math.ts"), A("claude", "Done. Added subtract under add in src/math.ts.")], m: C("apek", "nice"), want: null },
  { name: "answer agent's question", agents: ONE, t: [C("apek", "@claude add auth to the api"), A("claude", "Before I start: JWT or session cookies? JWT fits the mobile client better.")], m: C("apek", "jwt, go ahead"), want: "claude" },
  { name: "joke", agents: ONE, t: [C("noah", "the ci is a casino"), C("apek", "we keep losing")], m: C("noah", "lol true"), want: null },
  { name: "thinking aloud", agents: ONE, t: [], m: C("apek", "i'm thinking we might need to rewrite the auth layer at some point"), want: null },
  { name: "question needing code", agents: ONE, t: [], m: C("apek", "why is the test suite failing on main?"), want: "claude" },
  { name: "opinion for a person", agents: ONE, t: [], m: C("apek", "what do you think noah, should we ship friday?"), want: null },
  { name: "imperative", agents: ONE, t: [], m: C("apek", "run the tests and tell me what breaks"), want: "claude" },
  { name: "two agents, follow the active one", agents: TWO, t: [C("apek", "@codex add a dark mode toggle to settings"), A("codex", "Done: toggle in SettingsPanel.tsx, persisted in localStorage.")], m: C("apek", "ok now also update the README for that"), want: "codex" },
  { name: "two agents, named without @", agents: TWO, t: [C("apek", "@claude wire up the api client"), A("claude", "Done, client in src/api.ts.")], m: C("apek", "codex, can you handle the css part?"), want: "codex" },
  { name: "steer during run", agents: ONE, live: "claude", t: [C("apek", "@claude add a helper for parsing dates")], m: C("apek", "actually make it a class instead of a function"), want: "claude" },
  { name: "people talk during run", agents: ONE, live: "claude", t: [C("apek", "@claude add a helper for parsing dates")], m: C("apek", "noah i'll review it when it lands"), want: null },
  { name: "thanks", agents: ONE, t: [C("apek", "@claude fix the lint errors"), A("claude", "Fixed 4 lint errors in src/.")], m: C("apek", "thanks!"), want: null },
  { name: "where in the code", agents: ONE, t: [], m: C("noah", "where in the code do we parse the config file?"), want: "claude" },
  { name: "lunch", agents: ONE, t: [], m: C("noah", "we should probably grab lunch first"), want: null },
  { name: "yes please", agents: ONE, t: [C("apek", "@claude add subtract"), A("claude", "Done. Want me to add tests for it?")], m: C("apek", "yes please"), want: "claude" },
  { name: "lgtm to a person", agents: ONE, t: [C("apek", "@claude add subtract"), A("claude", "Done, pushed to beam/add-subtract.")], m: C("apek", "looks good to me noah, merge it?"), want: null },
  { name: "venting", agents: ONE, t: [], m: C("noah", "ugh the deploy broke again"), want: null },
  { name: "check why", agents: ONE, t: [C("noah", "ugh the deploy broke again")], m: C("apek", "can you check why the deploy broke?"), want: "claude" },
  { name: "announcement", agents: ONE, t: [], m: C("apek", "reminder: feature freeze is tomorrow"), want: null },
  { name: "hmm question about code", agents: ONE, t: [], m: C("apek", "hmm what does the rate limiter do if redis is down"), want: "claude" },
  { name: "dividing work between people", agents: ONE, t: [], m: C("apek", "i'll take the migration, you take the api noah"), want: null },
  { name: "explain code", agents: ONE, t: [], m: C("noah", "explain how the worktree logic works in packages/git"), want: "claude" },
  // harder
  { name: "code question aimed at a person", agents: ONE, t: [], m: C("apek", "noah, you wrote the rate limiter right? what happens when redis is down"), want: null },
  { name: "agent asked, person answers someone else", agents: ONE, t: [C("apek", "@claude add auth"), A("claude", "JWT or session cookies?"), C("noah", "apek what do you prefer?")], m: C("apek", "noah i honestly don't care, you pick"), want: null },
  { name: "person answers on behalf, agent should proceed", agents: ONE, t: [C("apek", "@claude add auth"), A("claude", "JWT or session cookies?"), C("noah", "apek what do you prefer?"), C("apek", "you pick")], m: C("noah", "ok let's do jwt then"), want: "claude" },
  { name: "sarcasm", agents: ONE, t: [C("apek", "@claude fix the flaky test"), A("claude", "Increased the timeout to 30s.")], m: C("noah", "great, so we fixed it by waiting longer"), want: null },
  { name: "sarcasm then real ask", agents: ONE, t: [C("apek", "@claude fix the flaky test"), A("claude", "Increased the timeout to 30s."), C("noah", "great, so we fixed it by waiting longer")], m: C("apek", "yeah no. find the actual race"), want: "claude" },
  { name: "design opinion, no repo needed", agents: ONE, t: [], m: C("apek", "redis or memcached for the session store?"), want: null },
  { name: "design question that needs the repo", agents: ONE, t: [], m: C("apek", "does our session store code assume redis anywhere, or could we swap it?"), want: "claude" },
  { name: "two agents, both named, pick first named", agents: TWO, t: [], m: C("apek", "claude take the backend and codex the frontend, start with the backend"), want: "claude" },
  { name: "two agents, the other one is running", agents: TWO, live: "codex", t: [C("apek", "@codex restyle the settings page")], m: C("apek", "claude can you look at the failing migration meanwhile"), want: "claude" },
  { name: "reply to agent's status, no action", agents: ONE, live: "claude", t: [C("apek", "@claude migrate the db"), A("claude", "Running the migration now, about 2 minutes.")], m: C("apek", "cool"), want: null },
  { name: "future tense plan", agents: ONE, t: [], m: C("apek", "tomorrow we should have claude rewrite the parser"), want: null },
  { name: "implicit continuation after long chat", agents: ONE, t: [C("apek", "@claude list the env vars we read"), A("claude", "DATABASE_URL, REDIS_URL, SESSION_SECRET, PORT."), C("noah", "SESSION_SECRET is set in prod right?"), C("apek", "yeah since june")], m: C("noah", "add a startup check that fails if any of those are missing"), want: "claude" },
];

const render = (c) => [
  `Chat: "bench" · repo acme/demo`,
  `Agents in this chat: ${c.agents.map((a) => `@${a.handle} (${a.name}, ${a.model})`).join(", ")}`,
  c.live ? `Currently running: @${c.live}` : "No agent is running.",
  ``, `Chat so far:`, c.t.map((x) => `${x.who}: ${x.text}`).join("\n") || "(nothing yet)", ``, `NEWEST: ${c.m.who}: ${c.m.text}`,
].join("\n");

async function ask(model, c) {
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

const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
const results = {};
for (const model of MODELS) {
  const rows = [];
  for (let i = 0; i < cases.length; i += 6) rows.push(...(await Promise.all(cases.slice(i, i + 6).map(async (c) => ({ c, r: await ask(model, c) })))));
  const ok = rows.filter(({ c, r }) => !r.error && r.agent === c.want);
  const wrong = rows.filter(({ c, r }) => !r.error && r.agent !== c.want).map(({ c, r }) => `${c.name} → ${r.agent ?? "none"} (${r.why ?? ""})`);
  const errors = rows.filter(({ r }) => r.error).map(({ c, r }) => `${c.name}: ${r.error}`);
  const lat = rows.filter(({ r }) => !r.error).map(({ r }) => r.ms).sort((a, b) => a - b);
  results[model] = { accuracy: `${ok.length}/${cases.length}`, p50ms: q(lat, 0.5) ?? null, p90ms: q(lat, 0.9) ?? null, maxms: lat[lat.length - 1] ?? null, wrong, errors: errors.slice(0, 3), provider: rows.find(({ r }) => r.provider)?.r.provider ?? null };
  console.error(`${model.padEnd(32)} ${results[model].accuracy}  p50 ${results[model].p50ms}ms  p90 ${results[model].p90ms}ms${errors.length ? `  errors ${errors.length}` : ""}`);
}
console.log(JSON.stringify(results, null, 1));
