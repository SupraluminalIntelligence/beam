import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
vi.mock("./runners", () => ({ runnerForToken: async (ctx: any, token: string) => { if (token !== "valid") throw new Error("Invalid token"); return ctx.db.get("runner"); } }));
vi.mock("./messages", () => ({ sendAs: vi.fn(async () => ({ id: "m1", kind: "dispatch", runner: "mac" })) }));
vi.mock("./runs", async (orig) => ({ ...(await orig<typeof import("./runs")>()), chooseRunner: vi.fn(async () => ({ name: "mac" })) }));
import { sendAs } from "./messages";
import { chooseRunner } from "./runs";
import { approve, cancel, claim, report, submitForRun } from "./compute";
import { RESUME_RETRIES_MS, fire } from "./jobResume";

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const spec = (title: string) => ({ version: 1, kind: "process", title, executable: "python3", args: ["run.py"], inputs: [], outputs: [], timeoutSeconds: 60 });

function fixture(permissionMode = "ask") {
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "alice" }], chats: [{ _id: "chat", workspaceId: "ws", private: true, members: ["alice"], agents: null }],
    members: [{ workspaceId: "ws", githubLogin: "alice" }], runners: [{ _id: "runner", ownerLogin: "alice", online: true, lastSeen: Date.now(), computeBackend: "local-process" }],
    agents: [{ _id: "agent", handle: "claude", harness: "claude", permissionMode }], runs: [{ _id: "run", chatId: "chat", runnerId: "runner", agentId: "agent", dispatchedBy: "alice", state: "working" }],
    simulationCases: [], simulationRevisions: [], computeJobs: [], computeAssets: [], files: [], messages: [],
  };
  const scheduled: { delay: number; args: any }[] = [];
  const db: any = {
    normalizeId: (_: string, id: string) => id, get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    query: (table: string) => { const filters: [string, unknown][] = []; let desc = false; const rows = () => { const r = (tables[table] ?? []).filter(x => filters.every(([k, v]) => x[k] === v)); return desc ? r.slice().reverse() : r; }; const chain: any = { withIndex: (_: string, fn: any) => { const q = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } }; fn(q); return chain; }, order: (d: string) => { desc = d === "desc"; return chain; }, collect: async () => rows(), take: async (n: number) => rows().slice(0, n), first: async () => rows()[0] ?? null }; return chain; },
    insert: async (table: string, value: any) => { const id = `${table}-${tables[table]!.length}`; tables[table]!.push({ _id: id, _creationTime: Date.now(), ...value }); return id; },
    patch: async (id: string, value: any) => Object.assign(await db.get(id), value),
  };
  const ctx: any = { db, scheduler: { runAfter: vi.fn(async (delay: number, _fn: unknown, args: any) => { scheduled.push({ delay, args }); }) } };
  const submit = (key: string, extra: any = {}) => call(submitForRun, ctx, { token: "valid", runId: "run", requestKey: key, spec: spec(key), ...extra });
  const finish = async (id: string, state = "succeeded") => { await call(claim, ctx, { token: "valid", id }); await call(report, ctx, { token: "valid", id, state, log: "", error: state === "failed" ? "solver diverged" : null }); };
  /** Runs what the job ends scheduled, as Convex would. */
  const drain = async () => { for (let i = scheduled.findIndex(s => s.delay === 0); i >= 0; i = scheduled.findIndex(s => s.delay === 0)) await call(fire, ctx, scheduled.splice(i, 1)[0]!.args); };
  return { ctx, tables, scheduled, submit, finish, drain };
}
beforeEach(() => { vi.mocked(sendAs).mockClear(); vi.mocked(chooseRunner).mockReset().mockResolvedValue({ name: "mac" } as any); });

it("continues the agent as the person who approved the job, once, after it ends", async () => {
  const { ctx, tables, submit, finish, drain } = fixture();
  const id = await submit("mesh", { continueWith: "read the residuals and refine if they stalled" });
  expect(tables.computeJobs![0].resume).toEqual({ agentId: "agent", handle: "claude", note: "read the residuals and refine if they stalled", group: "mesh" });
  await call(approve, ctx, { id });
  expect(tables.computeJobs![0].resume.by).toBe("alice");
  await finish(id); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  const [, , login, message] = vi.mocked(sendAs).mock.calls[0]!;
  expect(login).toBe("alice");
  expect(message).toMatchObject({ chatId: "chat", mentionHandle: "claude" });
  expect(message.text).toMatch(/^@claude The job you submitted has ended:\n- mesh: succeeded\n\nYou said you'd continue with: read the residuals/);
  expect(tables.computeJobs![0].resume.sentAt).toBeTypeOf("number");
  await call(fire, ctx, { jobId: id });
  expect(sendAs).toHaveBeenCalledOnce();
});

it("waits for every job submitted together, then sends one message with each outcome", async () => {
  const { submit, finish, drain, tables } = fixture("auto");
  const a = await submit("sweep-0", { continueWith: "compare the meshes", group: "sweep:s" });
  const b = await submit("sweep-1", { continueWith: "compare the meshes", group: "sweep:s" });
  expect(tables.computeJobs![0].resume.by).toBe("alice"); // auto mode: the person who started the run authorized it
  await finish(a); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  await finish(b, "failed"); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  expect(vi.mocked(sendAs).mock.calls[0]![3].text).toContain("The 2 jobs you submitted together have ended:\n- sweep-0: succeeded\n- sweep-1: failed (solver diverged)");
});

it("sends nothing for jobs nobody approved or everyone cancelled, and says why", async () => {
  const { ctx, submit, drain, tables } = fixture();
  const denied = await submit("denied", { continueWith: "go on" });
  await call(cancel, ctx, { id: denied }); await drain();
  expect(tables.computeJobs![0].resume.error).toMatch(/nobody approved/);
  const stopped = await submit("stopped", { continueWith: "go on" });
  await call(approve, ctx, { id: stopped }); await call(cancel, ctx, { id: stopped }); await drain();
  expect(tables.computeJobs![1].resume.error).toMatch(/every job was cancelled/);
  expect(sendAs).not.toHaveBeenCalled();
});

it("tries again later when no machine can run the agent, then gives up and says so", async () => {
  const { ctx, submit, finish, drain, scheduled, tables } = fixture("auto");
  vi.mocked(chooseRunner).mockRejectedValue(new Error("No online machine can run Claude Code"));
  const id = await submit("overnight", { continueWith: "report the drag" });
  await finish(id); await drain();
  for (const wait of RESUME_RETRIES_MS) {
    expect(scheduled.map(s => s.delay)).toEqual([wait]);
    expect(tables.computeJobs![0].resume.error).toMatch(/Couldn't start @claude for alice: No online machine.*Trying again later/);
    await call(fire, ctx, scheduled.shift()!.args);
  }
  expect(scheduled).toEqual([]);
  expect(tables.computeJobs![0].resume.error).not.toMatch(/Trying again/);
  expect(sendAs).not.toHaveBeenCalled();
});

it("leaves jobs that didn't ask to continue alone", async () => {
  const { ctx, submit, finish } = fixture("auto");
  await finish(await submit("plain"));
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  await expect(submit("blank", { continueWith: "  " })).rejects.toThrow("Say what you'll do");
});
