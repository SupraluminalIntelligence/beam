import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
vi.mock("./runners", () => ({ runnerForToken: async (ctx: any, token: string) => { if (token !== "valid") throw new Error("Invalid token"); return ctx.db.get("runner"); } }));
vi.mock("./messages", () => ({ sendAs: vi.fn(async () => ({ id: "m1", kind: "dispatch", runner: "mac" })) }));
vi.mock("./runs", async (orig) => ({ ...(await orig<typeof import("./runs")>()), chooseRunner: vi.fn(async () => ({ name: "mac" })) }));
import { sendAs } from "./messages";
import { chooseRunner } from "./runs";
import { approve, cancel, claim, closeContinuationForRun, report, submitForRun } from "./compute";
import { BUSY_RETRY_MS, RESUME_RETRIES_MS, fire } from "./jobResume";

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const spec = (title: string) => ({ version: 1, kind: "process", title, executable: "python3", args: ["run.py"], inputs: [], outputs: [], timeoutSeconds: 60 });

function fixture(permissionMode = "ask") {
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "alice" }], chats: [{ _id: "chat", workspaceId: "ws", private: true, members: ["alice"], agents: null }],
    members: [{ workspaceId: "ws", githubLogin: "alice" }], runners: [{ _id: "runner", ownerLogin: "alice", online: true, lastSeen: Date.now(), computeBackend: "local-process" }],
    agents: [{ _id: "agent", workspaceId: "ws", handle: "claude", harness: "claude", permissionMode }], runs: [{ _id: "run", chatId: "chat", runnerId: "runner", agentId: "agent", dispatchedBy: "alice", state: "working" }],
    simulationCases: [], simulationRevisions: [], computeJobs: [], computeAssets: [], files: [], messages: [],
  };
  const scheduled: { delay: number; args: any }[] = [];
  const db: any = {
    normalizeId: (_: string, id: string) => id, get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    query: (table: string) => { const filters: [string, unknown][] = []; let desc = false; const rows = () => { const r = (tables[table] ?? []).filter(x => filters.every(([k, v]) => k.split(".").reduce((o: any, p) => o?.[p], x) === v)); return desc ? r.slice().reverse() : r; }; const chain: any = { withIndex: (_: string, fn: any) => { const q = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } }; fn(q); return chain; }, order: (d: string) => { desc = d === "desc"; return chain; }, collect: async () => rows(), take: async (n: number) => rows().slice(0, n), first: async () => rows()[0] ?? null }; return chain; },
    insert: async (table: string, value: any) => { const id = `${table}-${tables[table]!.length}`; tables[table]!.push({ _id: id, _creationTime: Date.now(), ...value }); return id; },
    patch: async (id: string, value: any) => Object.assign(await db.get(id), value),
  };
  const ctx: any = { db, scheduler: { runAfter: vi.fn(async (delay: number, _fn: unknown, args: any) => { scheduled.push({ delay, args }); }) } };
  const submit = (key: string, extra: any = {}) => call(submitForRun, ctx, { token: "valid", runId: "run", requestKey: key, spec: spec(key), ...extra });
  /** The job runs and ends; by then the agent's turn has usually ended too. */
  const finish = async (id: string, state = "succeeded", turnEnded = true) => {
    if (turnEnded) tables.runs![0].state = "completed";
    await call(claim, ctx, { token: "valid", id }); await call(report, ctx, { token: "valid", id, state, log: "", error: state === "failed" ? "solver diverged" : null });
  };
  /** Runs what the job ends scheduled, as Convex would. */
  const drain = async () => { for (let i = scheduled.findIndex(s => s.delay === 0); i >= 0; i = scheduled.findIndex(s => s.delay === 0)) await call(fire, ctx, scheduled.splice(i, 1)[0]!.args); };
  return { ctx, tables, scheduled, submit, finish, drain };
}
const mac = { name: "mac", ownerLogin: "alice", harnesses: [{ harness: "claude", auth: "authenticated" }, { harness: "codex", auth: "authenticated", models: [{ model: "gpt-5", name: "GPT-5", efforts: ["high"] }] }] };
beforeEach(() => { vi.mocked(sendAs).mockClear(); vi.mocked(chooseRunner).mockReset().mockResolvedValue(mac as any); });

it("continues the agent as the person who approved the job, once, after it ends", async () => {
  const { ctx, tables, submit, finish, drain } = fixture();
  const id = await submit("mesh", { continueWith: "read the residuals and refine if they stalled" });
  expect(tables.computeJobs![0].resume).toEqual({ agentId: "agent", handle: "claude", note: "read the residuals and refine if they stalled", group: "job:mesh", size: 1 });
  await call(approve, ctx, { id });
  expect(tables.computeJobs![0].resume.by).toBe("alice");
  await finish(id); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  const [, , login, message] = vi.mocked(sendAs).mock.calls[0]!;
  expect(login).toBe("alice");
  expect(message).toMatchObject({ chatId: "chat", mentionHandle: "claude", localRunnerId: "runner", notify: false }); // Beam wrote it: an @login in the note notifies nobody
  expect(vi.mocked(chooseRunner).mock.calls[0]![4]).toBe("runner"); // the machine it was submitted from, as when the run began
  expect(message.text).toMatch(/^@claude The job you submitted has ended:\n- mesh \(computeJobs-0\): succeeded\n\nYou said you'd continue with: read the residuals/);
  expect(message.studyId).toBe(tables.computeJobs![0].simulationId); // the simulation the job belongs to
  expect(tables.computeJobs![0].resume.sentAt).toBeTypeOf("number");
  await call(fire, ctx, { jobId: id });
  expect(sendAs).toHaveBeenCalledOnce();
});

it("waits for every job submitted together, then sends one message with each outcome", async () => {
  const { submit, finish, drain, tables } = fixture("auto");
  const a = await submit("sweep-0", { continueWith: "compare the meshes", group: "sweep:s", size: 2 });
  const b = await submit("sweep-1", { continueWith: "compare the meshes", group: "sweep:s", size: 2 });
  expect(tables.computeJobs![0].resume.by).toBe("alice"); // auto mode: the person who started the run authorized it
  await finish(a); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  await finish(b, "failed"); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  expect(vi.mocked(sendAs).mock.calls[0]![3].text).toContain("The 2 jobs you submitted together have ended:\n- sweep-0 (computeJobs-0): succeeded\n- sweep-1 (computeJobs-1): failed (solver diverged)");
});

it("continues on the simulation the jobs belong to, even after the chat moved to another", async () => {
  const { submit, finish, drain, tables } = fixture("auto");
  const id = await submit("mesh", { continueWith: "refine" });
  tables.computeJobs![0].simulationId = "sim-a";
  await finish(id); await drain();
  expect(vi.mocked(sendAs).mock.calls[0]![3].studyId).toBe("sim-a");
});

it("never starts a different agent that shares the handle", async () => {
  const { submit, finish, drain, tables } = fixture("auto");
  const id = await submit("mesh", { continueWith: "refine" });
  tables.agents!.unshift({ _id: "other", workspaceId: "ws", handle: "claude", harness: "codex" });
  await finish(id); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  expect(tables.computeJobs![0].resume.error).toBe("Not sent: another agent in this workspace is also called @claude.");
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
  await expect(submit("blank", { continueWith: "  " })).rejects.toThrow("Say what you'll do");
  await finish(await submit("plain"));
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
});

it("waits for a sweep's later jobs even when its first ends before they are submitted", async () => {
  const { submit, finish, drain, tables } = fixture("auto");
  const a = await submit("sweep-0", { continueWith: "compare", group: "sweep:s", size: 2 });
  await finish(a); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  tables.runs![0].state = "working";
  await finish(await submit("sweep-1", { continueWith: "compare", group: "sweep:s", size: 2 })); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
});

it("waits for an agent at work in the chat to finish its turn before mentioning it", async () => {
  const { ctx, submit, finish, drain, scheduled, tables } = fixture("auto");
  const id = await submit("quick", { continueWith: "report it" });
  await finish(id, "succeeded", false); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  expect(scheduled.map(s => s.delay)).toEqual([BUSY_RETRY_MS]);
  expect(tables.computeJobs![0].resume.tries).toBeUndefined();
  tables.runs![0].state = "completed";
  await call(fire, ctx, scheduled.shift()!.args);
  expect(sendAs).toHaveBeenCalledOnce();
});

it("treats a retried submission asking to continue differently, or by another agent, as a different request", async () => {
  const { submit, tables } = fixture("auto");
  const id = await submit("k", { continueWith: "plot it" });
  expect(await submit("k", { continueWith: " plot it " })).toBe(id);
  await expect(submit("k", { continueWith: "tabulate it" })).rejects.toThrow("different continueWith");
  await expect(submit("k")).rejects.toThrow("different continueWith");
  await expect(submit("k", { continueWith: "plot it", group: "sweep:k", size: 3 })).rejects.toThrow("different continueWith"); // a sweep whose key collides
  tables.agents!.push({ _id: "agent2", handle: "codex", harness: "codex", permissionMode: "auto" }); tables.runs![0].agentId = "agent2";
  await expect(submit("k", { continueWith: "plot it" })).rejects.toThrow("different continueWith");
});

it("checks a finished group once, however many of its jobs scheduled a check", async () => {
  const { ctx, submit, finish, scheduled, tables } = fixture("auto");
  vi.mocked(chooseRunner).mockRejectedValue(new Error("No online machine can run Claude Code"));
  const ids = [await submit("s-0", { continueWith: "go", group: "sweep:s", size: 2 }), await submit("s-1", { continueWith: "go", group: "sweep:s", size: 2 })];
  await finish(ids[0]!); await finish(ids[1]!);
  // Both ends scheduled a check before either ran: the second finds the first's retry scheduled and leaves it.
  for (const s of scheduled.splice(0)) await call(fire, ctx, s.args);
  expect(scheduled.map(s => s.delay)).toEqual([RESUME_RETRIES_MS[0]]);
  expect(tables.computeJobs!.map(j => j.resume.tries)).toEqual([1, 1]);
});

it("keeps job groups apart from sweeps whose request key looks like one, and closes a sweep that stopped partway", async () => {
  const { ctx, submit, finish, drain, tables } = fixture("auto");
  const sweep = await submit("s-0", { continueWith: "compare", group: "sweep:s", size: 3 });
  const lone = await submit("sweep:s", { continueWith: "plot" });
  expect(tables.computeJobs![1].resume.group).toBe("job:sweep:s");
  await finish(sweep); await finish(lone); await drain();
  expect(sendAs).toHaveBeenCalledOnce(); // the lone job only; the sweep still waits for its other two
  expect(vi.mocked(sendAs).mock.calls[0]![3].text).toContain("plot");
  tables.runs![0].state = "working";
  expect(await call(closeContinuationForRun, ctx, { token: "valid", runId: "run", group: "sweep:s" })).toBe(1);
  tables.runs![0].state = "completed"; await drain();
  expect(sendAs).toHaveBeenCalledTimes(2);
});

it("sends a retried sweep's new jobs as their own round once a closed group has already sent", async () => {
  const { ctx, submit, finish, drain, tables } = fixture("auto");
  await finish(await submit("s-0", { continueWith: "compare", group: "sweep:s", size: 2 }));
  tables.runs![0].state = "working";
  await call(closeContinuationForRun, ctx, { token: "valid", runId: "run", group: "sweep:s" });
  tables.runs![0].state = "completed"; await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  tables.runs![0].state = "working"; // the agent retries the sweep: s-0 is reused, s-1 is new
  await finish(await submit("s-1", { continueWith: "compare", group: "sweep:s", size: 2 })); await drain();
  expect(sendAs).toHaveBeenCalledTimes(2);
  expect(vi.mocked(sendAs).mock.calls[1]![3].text).toContain("- s-0 (computeJobs-0): succeeded\n- s-1 (computeJobs-1): succeeded");
});

it("closes a retried sweep from its unsent jobs when the retry also stops partway", async () => {
  const { ctx, submit, finish, drain, tables } = fixture("auto");
  await finish(await submit("s-0", { continueWith: "compare", group: "sweep:s", size: 3 }));
  tables.runs![0].state = "working";
  await call(closeContinuationForRun, ctx, { token: "valid", runId: "run", group: "sweep:s" });
  tables.runs![0].state = "completed"; await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  // The retry adds s-1, which ends while the sweep still expects s-2, and then the sweep stops again.
  tables.runs![0].state = "working";
  await finish(await submit("s-1", { continueWith: "compare", group: "sweep:s", size: 3 })); await drain();
  expect(sendAs).toHaveBeenCalledOnce();
  tables.runs![0].state = "working";
  expect(await call(closeContinuationForRun, ctx, { token: "valid", runId: "run", group: "sweep:s" })).toBe(2);
  tables.runs![0].state = "completed"; await drain();
  expect(sendAs).toHaveBeenCalledTimes(2);
});

it("retries, rather than loses, a continuation the agent's settings can't start", async () => {
  const { submit, finish, drain, scheduled, tables } = fixture("auto");
  Object.assign(tables.agents![0], { harness: "codex", model: "gpt-4", effort: "high" });
  await finish(await submit("j", { continueWith: "go" })); await drain();
  expect(sendAs).not.toHaveBeenCalled();
  expect(scheduled.map(s => s.delay)).toEqual([RESUME_RETRIES_MS[0]]);
  expect(tables.computeJobs![0].resume.error).toMatch(/gpt-4 is unavailable on the selected Codex connection/);
});
