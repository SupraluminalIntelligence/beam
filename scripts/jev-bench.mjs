// JEV_API_KEY=... node scripts/jev-bench.mjs. Synthetic fixtures only; never dispatches work.
import { askJev } from "../packages/contracts/src/jev.ts";
import { SYSTEM } from "../convex/routerPrompt.ts";
import { cases } from "./router-cases.mjs";
const key = process.env.JEV_API_KEY;
if (!key) throw new Error("Set JEV_API_KEY in the process environment");
const threshold = Number(process.env.JEV_THRESHOLD ?? 0.9);
const repeats = Number(process.env.BENCH_REPEATS ?? 1);
const rows = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  for (let i = 0; i < cases.length; i += 4) {
    rows.push(...await Promise.all(cases.slice(i, i + 4).map(async (c) => {
      const context = { title: "bench", repo: "acme/demo", agents: c.agents, liveHandle: c.live ?? null, transcript: c.t.map((t) => ({ ...t, kind: "text" })), message: c.m };
      const start = performance.now();
      try { return { name: c.name, want: c.want, ...await askJev(key, context, SYSTEM, { threshold, timeoutMs: 10000 }), ms: Math.round(performance.now() - start) }; }
      catch (e) { return { name: c.name, want: c.want, error: e.message, ms: Math.round(performance.now() - start) }; }
    })));
  }
}
const good = rows.filter((r) => !r.error), times = good.map((r) => r.ms).sort((a, b) => a - b);
const quantile = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? null;
console.log(JSON.stringify({ threshold, cases: rows.length, correct: good.filter((r) => r.agent === r.want).length, rawCorrect: good.filter((r) => r.candidate === r.want).length, falseActivations: good.filter((r) => r.want === null && r.agent !== null).length, missedRequests: good.filter((r) => r.want !== null && r.agent === null).length, wrongAgent: good.filter((r) => r.want !== null && r.agent !== null && r.agent !== r.want).length, errors: rows.filter((r) => r.error).length, medianMs: quantile(0.5), p95Ms: quantile(0.95), rows }, null, 2));
