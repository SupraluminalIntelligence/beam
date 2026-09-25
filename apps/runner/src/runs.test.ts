import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunEvent } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "@beam/harness";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const run = promisify(execFile);
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (args: string[], cwd: string) => run("git", args, { cwd, env: { ...process.env, ...identity } }).then((r) => r.stdout.trim());

/** What each test's fake harness does when the runner talks to it. */
interface Script {
  send?(s: FakeSession, text: string, messageId: string): Promise<void>;
  respond?(): Promise<void>;
  stop?(): Promise<void>;
  resumeCursor?(): unknown;
}
let script: Script = {};
const turnDone = { type: "turn.completed", runId: "run1", turnId: "t1" } as unknown as RunEvent;

class FakeSession implements Session {
  cwd: string;
  private queue: RunEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  constructor(cwd: string) { this.cwd = cwd; }
  emit(e: RunEvent) { this.queue.push(e); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  send(text: string, messageId: string) { return script.send ? script.send(this, text, messageId) : Promise.resolve(); }
  async interrupt() { this.emit(turnDone); this.close(); }
  respond() { return script.respond ? script.respond() : Promise.resolve(); }
  stop() { this.close(); return script.stop ? script.stop() : Promise.resolve(); }
  resumeCursor() { return script.resumeCursor ? script.resumeCursor() : null; }
  get events(): AsyncIterable<RunEvent> {
    const self = this;
    return { async *[Symbol.asyncIterator]() {
      for (;;) {
        while (self.queue.length) yield self.queue.shift()!;
        if (self.closed) return;
        await new Promise<void>((r) => { self.wake = r; });
        self.wake = null;
      }
    } };
  }
}

const fakeAdapter: HarnessAdapter = {
  kind: "claude",
  probe: async () => ({ harness: "claude", installed: true, version: "1", auth: "authenticated", plan: null, email: null, probedAt: 0, message: null }) as never,
  start: async (input: StartSession) => new FakeSession(input.cwd),
};
vi.mock("@beam/harness", async (original) => ({ ...(await original<typeof import("@beam/harness")>()), adapters: { claude: fakeAdapter } }));


/** A Convex client that answers the runner's queries from fixtures and records its mutations. */
function fakeClient(opts: { detailError?: string; landFailsOnce?: boolean } = {}) {
  const mutations: { name: string; args: Record<string, unknown> }[] = [];
  let control: ((c: unknown) => void) | null = null;
  const detail = {
    run: { _id: "run1", branch: null, resumeCursor: null },
    chat: { _id: "chat1", workspaceId: "ws1", title: "Fix it", repos: ["acme/app"] },
    agent: { _id: "agent1", harness: "claude", handle: "claude", model: "m", effort: "high", permissionMode: "auto", alwaysAllow: [], contextPolicy: "thread", workspaceId: "ws1" },
    dispatch: { _id: "msg0", text: "@claude fix it", author: "george" },
    transcript: [], previous: null, changes: [], agents: [],
  };
  const answers: Record<string, unknown> = {
    "runs:detail": detail,
    "files:forRun": [],
    "files:contextForRun": [],
    "compute:simulationForRun": { cases: [], jobs: [], activeStudyId: null, messageStudyContext: null },
  };
  const client = {
    query: async (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "runs:detail" && opts.detailError) throw new Error(opts.detailError);
      return answers[name];
    },
    mutation: async (ref: never, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      if (name === "runs:land" && opts.landFailsOnce) { opts.landFailsOnce = false; throw new Error("Connection lost"); }
      mutations.push({ name, args });
      if (name === "runs:say") return "said1";
      if (name === "resources:contribute") return "resource1";
      return null;
    },
    onUpdate: (ref: never, _args: unknown, cb: (v: unknown) => void) => {
      const name = getFunctionName(ref);
      if (name === "runs:queuedFor") queueMicrotask(() => cb([{ _id: "run1" }]));
      if (name === "runs:control") control = cb;
      return () => {};
    },
  };
  return {
    client,
    mutations,
    control: (c: unknown) => control?.(c),
    landed: () => mutations.find((m) => m.name === "runs:land")?.args as { state: string; landing: { repos: { pushed: boolean; error: string | null }[] } } | undefined,
    errors: () => mutations.filter((m) => m.name === "runs:appendEvents").flatMap((m) => m.args["events"] as RunEvent[]).filter((e) => e.type === "error"),
  };
}

let root: string;
let saved: { home: string | undefined; base: string | undefined };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beam-runs-"));
  saved = { home: process.env["BEAM_HOME"], base: process.env["BEAM_GIT_BASE"] };
  process.env["BEAM_HOME"] = join(root, "home");
  process.env["BEAM_GIT_BASE"] = `file://${join(root, "remote")}/`;
  const bare = join(root, "remote", "acme", "app.git");
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  const seed = join(root, "seed");
  await run("git", ["clone", bare, seed]);
  await git(["checkout", "-b", "main"], seed);
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-m", "seed"], seed);
  await git(["push", "origin", "main"], seed);
  script = {};
});

afterEach(async () => {
  if (saved.home === undefined) delete process.env["BEAM_HOME"]; else process.env["BEAM_HOME"] = saved.home;
  if (saved.base === undefined) delete process.env["BEAM_GIT_BASE"]; else process.env["BEAM_GIT_BASE"] = saved.base;
  await rm(root, { recursive: true, force: true });
});

/** Host the one queued run to its end and return what the runner told Convex. */
async function host() {
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(active.size).toBe(1));
  await Promise.all(active.values());
  return fake;
}

/** The agent edits the repo folder, the way a real harness would during a turn. */
const edit = (s: FakeSession, file = "fix.txt") => writeFile(join(s.cwd, "app", file), "fixed\n");
const pushedBranches = async () => (await git(["branch", "--list", "beam/*"], join(root, "remote", "acme", "app.git"))).split("\n").filter(Boolean);

it("lands a finished turn: commits, pushes and reports the run as landed", async () => {
  script.send = async (s) => { await edit(s); s.emit(turnDone); };
  const fake = await host();
  expect(fake.landed()?.state).toBe("landed");
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true, error: null });
  expect(await pushedBranches()).toHaveLength(1);
}, 30_000);

it("still lands when the harness rejects the first message", async () => {
  script.send = async (s) => { await edit(s); throw new Error("harness went away"); };
  const fake = await host();
  expect(fake.landed()?.state).toBe("failed");
  expect(fake.errors().map((e) => (e as { message: string }).message).join()).toMatch(/harness went away/);
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("ends and lands the run when a steer cannot be delivered", async () => {
  let fakeSession: FakeSession | null = null;
  script.send = async (s, _text, messageId) => {
    if (messageId === "msg0") { fakeSession = s; await edit(s); return; }
    throw new Error("steer rejected");
  };
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(fakeSession).not.toBeNull());
  fake.control({ state: "working", steers: [{ id: "msg1", text: "also this", author: "george" }], resolutions: [], interruptRequestedAt: null });
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("failed");
  expect(fake.errors().map((e) => (e as { message: string }).message).join()).toMatch(/steer rejected/);
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("ends and lands the run when an approval cannot be delivered", async () => {
  let fakeSession: FakeSession | null = null;
  script.send = async (s) => { fakeSession = s; await edit(s); s.emit({ type: "request.opened", runId: "run1" } as unknown as RunEvent); };
  script.respond = async () => { throw new Error("request already closed"); };
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(fakeSession).not.toBeNull());
  fake.control({ state: "working", steers: [], resolutions: [{ requestId: "req1", decision: "allow", by: "george" }], interruptRequestedAt: null });
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("failed");
  expect(fake.errors().map((e) => (e as { message: string }).message).join()).toMatch(/george's answer.*request already closed/);
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("lands even when stopping the harness fails", async () => {
  script.send = async (s) => { await edit(s); s.emit(turnDone); };
  script.stop = async () => { throw new Error("stop failed"); };
  const fake = await host();
  expect(fake.landed()?.state).toBe("landed");
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("lands an interrupted run with the work done so far", async () => {
  let fakeSession: FakeSession | null = null;
  script.send = async (s) => { fakeSession = s; await edit(s); };
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(fakeSession).not.toBeNull());
  fake.control({ state: "working", steers: [], resolutions: [], interruptRequestedAt: Date.now() });
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("interrupted");
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("stops and lands a run the server already ended while the runner was away", async () => {
  let fakeSession: FakeSession | null = null;
  script.send = async (s) => { fakeSession = s; await edit(s); };
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(fakeSession).not.toBeNull());
  fake.control({ state: "failed", steers: [], resolutions: [], interruptRequestedAt: null });
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("failed");
  expect(fake.errors().map((e) => (e as { message: string }).message).join()).toMatch(/already ended/);
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("keeps the server's failure when it arrives just after the agent finished", async () => {
  let fake: ReturnType<typeof fakeClient> | null = null;
  script.send = async (s) => {
    await edit(s);
    s.emit(turnDone);
    await new Promise((r) => setTimeout(r, 20)); // the runner has seen the turn close
    fake!.control({ state: "failed", steers: [], resolutions: [], interruptRequestedAt: null });
  };
  const { watchRuns } = await import("./runs.ts");
  fake = fakeClient();
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(active.size).toBe(1));
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("failed");
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);

it("ends a run it cannot even read instead of leaving it queued", async () => {
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient({ detailError: "Server Error" });
  watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(fake.landed()).toBeDefined(), { timeout: 3000 });
  expect(fake.landed()).toMatchObject({ state: "failed", landing: { repos: [], error: expect.stringMatching(/Server Error/) } });
}, 30_000);

it("pushes the work of a run that crashes before its landing step", async () => {
  script.send = async (s) => { await edit(s); s.emit(turnDone); };
  script.resumeCursor = () => { throw new Error("cursor unreadable"); };
  const fake = await host();
  expect(fake.landed()).toMatchObject({ state: "failed", landing: { error: expect.stringMatching(/cursor unreadable/) } });
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
  expect(await pushedBranches()).toHaveLength(1);
}, 30_000);

it("reports the real landing again when reporting it failed the first time", async () => {
  script.send = async (s) => { await edit(s); s.emit(turnDone); };
  const { watchRuns } = await import("./runs.ts");
  const fake = fakeClient({ landFailsOnce: true });
  const { active } = watchRuns(fake.client as never, "token");
  await vi.waitFor(() => expect(active.size).toBe(1));
  await Promise.all(active.values());
  expect(fake.landed()?.state).toBe("landed");
  expect(fake.landed()?.landing.repos[0]).toMatchObject({ pushed: true });
}, 30_000);
