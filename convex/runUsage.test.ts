import { expect, it, vi } from "vitest";
vi.mock("./notifications", () => ({ notifyRun: async () => {}, resolveInputNotifications: async () => {} }));
import { appendEvents } from "./runs";

const window = (usedPercent: number) => ({ id: "primary", kind: "session", label: "5-hour session", usedPercent, resetsAt: null });

/** The run's own runner, found by token; streamed plan windows land on the account the run used. */
function fixture() {
  const runner = { _id: "runner", tokenId: "tok", harnesses: [
    { harness: "codex", connectionId: "work", usage: { checkedAt: 1, windows: [window(10)] } },
    { harness: "codex", usage: { checkedAt: 1, windows: [window(10)] } },
  ] };
  const tables: Record<string, any[]> = {
    runners: [runner],
    agents: [{ _id: "agent", harness: "codex" }],
    runs: [{ _id: "run", runnerId: "runner", agentId: "agent", execution: { connectionId: "work" } }],
    runEvents: [],
  };
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, doc: any) => { tables[table]!.push({ _id: `${table}${tables[table]!.length}`, ...doc }); },
    patch: async (id: string, patch: any) => { Object.assign(Object.values(tables).flat().find((r) => r._id === id), patch); },
    query: (table: string) => { const chain: any = { withIndex: () => chain, order: () => chain, first: async () => tables[table]!.at(-1) ?? null }; return chain; },
  };
  return { tables, db, runner };
}

vi.mock("./runners", async (original) => ({ ...(await original<typeof import("./runners")>()), runnerForToken: async (ctx: any) => ctx.db.get("runner") }));

it("applies streamed plan windows to the run's connection and keeps them out of the chat", async () => {
  const f = fixture();
  await (appendEvents as any)._handler({ db: f.db }, { token: "t", runId: "run", events: [
    { type: "usage.updated", runId: "run", windows: [window(64)] },
    { type: "status", runId: "run", message: "thinking", until: null },
  ] });
  expect(f.runner.harnesses.map((h: any) => h.usage.windows[0].usedPercent)).toEqual([64, 10]);
  expect(f.tables["runEvents"]!.map((e) => e.event.type)).toEqual(["status"]);
});
