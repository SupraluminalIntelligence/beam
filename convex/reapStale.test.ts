import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
vi.mock("./notifications", () => ({ notifyRun: async () => {}, resolveInputNotifications: async () => {} }));
import { reapStale } from "./runs";

const NOW = 1_000_000_000;

/** A db that only answers indexed reads: a full-table scan of runs would hit Convex's read limits as history grows. */
function fixture() {
  const tables: Record<string, any[]> = {
    runners: [
      { _id: "awake", online: true, lastSeen: NOW - 10_000 },
      { _id: "asleep", online: true, lastSeen: NOW - 10 * 60_000 },
    ],
    runs: [
      { _id: "healthy", runnerId: "awake", state: "working" },
      { _id: "stranded", runnerId: "asleep", state: "working" },
      { _id: "queuedOnSleeper", runnerId: "asleep", state: "queued" },
      { _id: "unacked", runnerId: "awake", state: "working", interruptRequestedAt: NOW - 120_000 },
      { _id: "justStopped", runnerId: "awake", state: "working", interruptRequestedAt: NOW - 10_000 },
      { _id: "done", runnerId: "asleep", state: "landed" },
    ],
    runEvents: [],
  };
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, doc: any) => { const _id = `${table}${tables[table]!.length}`; tables[table]!.push({ _id, ...doc }); return _id; },
    patch: async (id: string, patch: any) => { Object.assign(Object.values(tables).flat().find((r) => r._id === id), patch); },
    query: (table: string) => {
      const filters: [string, unknown][] = [];
      const rows = () => tables[table]!.filter((r) => filters.every(([k, v]) => r[k] === v));
      const chain: any = {
        withIndex: (_name: string, f: any) => { const q: any = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } }; f(q); return chain; },
        order: () => chain,
        first: async () => rows().at(-1) ?? null,
        collect: async () => { if (!filters.length) throw new Error(`unindexed scan of ${table}`); return rows(); },
      };
      return chain;
    },
  };
  return { tables, db, state: (id: string) => tables["runs"]!.find((r) => r._id === id)!.state };
}

it("ends runs whose runner went quiet or never acknowledged a stop, and nothing else", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const f = fixture();
  await (reapStale as any)._handler({ db: f.db }, {});
  expect(f.state("stranded")).toBe("failed");
  expect(f.state("queuedOnSleeper")).toBe("failed");
  expect(f.state("unacked")).toBe("interrupted");
  expect(f.state("healthy")).toBe("working");
  expect(f.state("justStopped")).toBe("working");
  expect(f.state("done")).toBe("landed");
  const messages = f.tables["runEvents"]!.map((e) => `${e.runId}: ${e.event.message}`);
  expect(messages).toEqual(expect.arrayContaining(["stranded: run ended: the runner went offline", "unacked: run ended: the runner did not acknowledge stop"]));
  expect(messages).toHaveLength(3);
});
