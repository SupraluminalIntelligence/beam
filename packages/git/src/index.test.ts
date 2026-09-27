import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchFrom, defaultBranch, ensureMirror, ensureRepoWorktree, landRepo, mirrorPath, repoDirName, threadBranch } from "./index.ts";

const run = promisify(execFile);
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (args: string[], cwd: string) => run("git", args, { cwd, env: { ...process.env, ...identity } }).then((r) => r.stdout.trim());
const write = (path: string, text: string) => writeFile(path, text);

let root: string;
let saved: { home: string | undefined; base: string | undefined };

/** A bare "GitHub" repo at <root>/remote/<repo>.git with one commit on `branch`. */
async function remote(repo: string, branch = "main") {
  const bare = join(root, "remote", `${repo}.git`);
  await run("git", ["init", "--bare", `--initial-branch=${branch}`, bare]);
  const seed = join(root, "seed", repo);
  await run("git", ["clone", bare, seed]);
  await git(["checkout", "-b", branch], seed);
  await write(join(seed, "README.md"), "hello\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-m", "seed"], seed);
  await git(["push", "origin", branch], seed);
  return { bare, seed };
}

/** Someone else pushes a commit to `branch`, the way a teammate or a second machine would. */
async function pushFromElsewhere(repo: string, branch: string, file: string) {
  const other = join(root, "other", `${repo}-${file}`);
  await run("git", ["clone", "--branch", branch, join(root, "remote", `${repo}.git`), other]);
  await write(join(other, file), `${file}\n`);
  await git(["add", "-A"], other);
  await git(["commit", "-m", `add ${file}`], other);
  await git(["push", "origin", branch], other);
}

const remoteHead = (repo: string, branch: string) => git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], join(root, "remote", `${repo}.git`)).catch(() => "");
const useMachine = (name: string) => { process.env["BEAM_HOME"] = join(root, name); };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beam-git-"));
  saved = { home: process.env["BEAM_HOME"], base: process.env["BEAM_GIT_BASE"] };
  process.env["BEAM_GIT_BASE"] = `file://${join(root, "remote")}/`;
  useMachine("machine-a");
});

afterEach(async () => {
  if (saved.home === undefined) delete process.env["BEAM_HOME"]; else process.env["BEAM_HOME"] = saved.home;
  if (saved.base === undefined) delete process.env["BEAM_GIT_BASE"]; else process.env["BEAM_GIT_BASE"] = saved.base;
  await rm(root, { recursive: true, force: true });
});

describe("names", () => {
  it("names thread branches from the title and the last six characters of the thread id", () => {
    expect(threadBranch("Fix the Login Bug!", "k57abcDEF123", 0)).toBe("beam/fix-the-login-bug-def123");
    expect(threadBranch("Fix the Login Bug!", "k57abcDEF123", 2)).toBe("beam/fix-the-login-bug-def123-3");
    expect(threadBranch("日本語", "k57abcDEF123", 0)).toBe("beam/chat-def123");
  });

  it("makes branch names under the harness from an agent's name or a PR title", () => {
    expect(branchFrom("claude", "chat-square-status")).toBe("claude/chat-square-status");
    expect(branchFrom("codex", "codex/Chat Square Status")).toBe("codex/chat-square-status");
    expect(branchFrom("claude", "beam/chat-square-status")).toBe("claude/chat-square-status");
    expect(branchFrom("omp", "Read STEP bodies from chat attachments in the mesher")).toBe("omp/read-step-bodies-from-chat-attachments");
    expect(branchFrom("claude", "日本語")).toBe("claude/chat");
  });

  it("uses owner-name folders only when two repos share a name", () => {
    expect(repoDirName("acme/app", ["acme/app", "acme/api"])).toBe("app");
    expect(repoDirName("acme/app", ["acme/app", "other/app"])).toBe("acme-app");
  });
});

describe("mirror", () => {
  it("clones once and reads the default branch", async () => {
    await remote("acme/app");
    const [a, b] = await Promise.all([ensureMirror("acme/app"), ensureMirror("acme/app")]);
    expect(a).toBe(mirrorPath("acme/app"));
    expect(b).toBe(a);
    expect(await defaultBranch("acme/app")).toBe("main");
  });

  it("finds a default branch that is not main", async () => {
    await remote("acme/old", "master");
    await ensureMirror("acme/old");
    expect(await defaultBranch("acme/old")).toBe("master");
  });
});

describe("worktree and landing", () => {
  const repo = "acme/app";
  const branch = "beam/fix-def123";

  it("leaves a clean worktree alone: no commit, no pushed branch", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    const r = await landRepo(wt, branch, "main", "nothing");
    expect(r).toMatchObject({ dirty: false, committed: false, pushed: false });
    expect(await remoteHead(repo, branch)).toBe("");
  });

  it("commits, pushes and reports the diff against the base", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "a.txt"), "one\ntwo\n");
    const r = await landRepo(wt, branch, "main", "Run 1");
    expect(r).toMatchObject({ dirty: true, committed: true, pushed: true, add: 2, del: 0, files: 1 });
    expect(await remoteHead(repo, branch)).toBe(await git(["rev-parse", "HEAD"], wt));
  });

  it("commits as the machine's git identity, and as Beam only when git has none", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    const saved = { global: process.env["GIT_CONFIG_GLOBAL"], system: process.env["GIT_CONFIG_NOSYSTEM"] };
    process.env["GIT_CONFIG_GLOBAL"] = join(root, "empty-gitconfig");
    process.env["GIT_CONFIG_NOSYSTEM"] = "1";
    try {
      await write(join(root, "empty-gitconfig"), "");
      await write(join(wt, "a.txt"), "one\n");
      await landRepo(wt, branch, "main", "Run 1");
      expect(await git(["log", "-1", "--format=%an <%ae>"], wt)).toBe("Beam <beam@supraluminal.dev>");
      await write(join(root, "empty-gitconfig"), "[user]\n\tname = Ada\n\temail = ada@example.com\n");
      await write(join(wt, "b.txt"), "two\n");
      await landRepo(wt, branch, "main", "Run 2");
      expect(await git(["log", "-1", "--format=%an <%ae>"], wt)).toBe("Ada <ada@example.com>");
    } finally {
      if (saved.global === undefined) delete process.env["GIT_CONFIG_GLOBAL"]; else process.env["GIT_CONFIG_GLOBAL"] = saved.global;
      if (saved.system === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"]; else process.env["GIT_CONFIG_NOSYSTEM"] = saved.system;
    }
  });

  it("lands a second run on top of the first in the same worktree", async () => {
    await remote(repo);
    const path = join(root, "machine-a", "t", "app");
    let wt = await ensureRepoWorktree(repo, path, branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");
    wt = await ensureRepoWorktree(repo, path, branch, "main");
    await write(join(wt, "b.txt"), "two\n");
    const r = await landRepo(wt, branch, "main", "Run 2");
    expect(r).toMatchObject({ pushed: true, files: 2 });
  });

  it("picks up a branch another machine pushed", async () => {
    await remote(repo);
    let wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "a.txt"), "from a\n");
    await landRepo(wt, branch, "main", "Run on A");

    useMachine("machine-b");
    wt = await ensureRepoWorktree(repo, join(root, "machine-b", "t", "app"), branch, "main");
    expect(await git(["log", "-1", "--format=%s"], wt)).toBe("Run on A");
  });

  it("brings an existing worktree up to date when the branch moved elsewhere", async () => {
    await remote(repo);
    const path = join(root, "machine-a", "t", "app");
    let wt = await ensureRepoWorktree(repo, path, branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");

    await pushFromElsewhere(repo, branch, "teammate.txt");

    wt = await ensureRepoWorktree(repo, path, branch, "main");
    await write(join(wt, "b.txt"), "two\n");
    const r = await landRepo(wt, branch, "main", "Run 2");
    expect(r.pushed).toBe(true);
    expect(await git(["log", "--format=%s", "-3"], wt)).toBe("Run 2\nadd teammate.txt\nRun 1");
  });

  it("brings a stale local branch up to date when the worktree folder is new", async () => {
    await remote(repo);
    let wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t1", "app"), branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");
    await git(["worktree", "remove", wt], mirrorPath(repo));

    await pushFromElsewhere(repo, branch, "teammate.txt");

    wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t2", "app"), branch, "main");
    await write(join(wt, "b.txt"), "two\n");
    const r = await landRepo(wt, branch, "main", "Run 2");
    expect(r.pushed).toBe(true);
    expect(await git(["log", "--format=%s", "-3"], wt)).toBe("Run 2\nadd teammate.txt\nRun 1");
  });

  it("takes a teammate's push that landed while the run was working, then pushes", async () => {
    await remote(repo);
    let wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");

    wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "b.txt"), "two\n");
    await pushFromElsewhere(repo, branch, "teammate.txt");
    const r = await landRepo(wt, branch, "main", "Run 2");
    expect(r).toMatchObject({ pushed: true, files: 3 });
    expect(await remoteHead(repo, branch)).toBe(await git(["rev-parse", "HEAD"], wt));
  });

  it("merges a diverged branch even when merge.ff is set to only", async () => {
    await remote(repo);
    let wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await git(["config", "merge.ff", "only"], mirrorPath(repo));
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");

    wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "b.txt"), "two\n");
    await pushFromElsewhere(repo, branch, "teammate.txt");
    const r = await landRepo(wt, branch, "main", "Run 2");
    expect(r.pushed).toBe(true);
    expect(await remoteHead(repo, branch)).toBe(await git(["rev-parse", "HEAD"], wt));
  });

  it("reports the push's own error when a new branch is refused", async () => {
    const { bare } = await remote(repo);
    await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", { mode: 0o755 });
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await expect(landRepo(wt, branch, "main", "Run 1")).rejects.toThrow(/no pushes today/);
  });

  it("fails the push without leaving a half-done merge when the teammate's push conflicts", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");

    const other = join(root, "other", "conflict");
    await run("git", ["clone", "--branch", branch, join(root, "remote", `${repo}.git`), other]);
    await write(join(other, "a.txt"), "theirs\n");
    await git(["commit", "-am", "theirs"], other);
    await git(["push", "origin", branch], other);

    await write(join(wt, "a.txt"), "ours\n");
    await expect(landRepo(wt, branch, "main", "Run 2")).rejects.toThrow(/push/);
    expect(await git(["status", "--porcelain"], wt)).toBe("");
    expect(await git(["log", "-1", "--format=%s"], wt)).toBe("Run 2");
  });

  it("recreates a worktree whose folder was deleted by hand", async () => {
    await remote(repo);
    const path = join(root, "machine-a", "t", "app");
    let wt = await ensureRepoWorktree(repo, path, branch, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, branch, "main", "Run 1");
    await rm(path, { recursive: true, force: true });

    wt = await ensureRepoWorktree(repo, path, branch, "main");
    expect(await git(["log", "-1", "--format=%s"], wt)).toBe("Run 1");
  });
});

describe("naming a branch on its first push", () => {
  const repo = "acme/app";
  const placeholder = "beam/fix-it-def123-0123456789ab";

  it("pushes under the new name and leaves the placeholder behind", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), placeholder, "main");
    await write(join(wt, "a.txt"), "one\n");
    const r = await landRepo(wt, placeholder, "main", "Run 1", { to: "claude/chat-status" });
    expect(r).toMatchObject({ pushed: true, branch: "claude/chat-status" });
    expect(await remoteHead(repo, "claude/chat-status")).not.toBe("");
    expect(await remoteHead(repo, placeholder)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe("claude/chat-status");
  });

  it("does not rename when there is nothing to push", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), placeholder, "main");
    const r = await landRepo(wt, placeholder, "main", "nothing", { to: "claude/chat-status" });
    expect(r).toMatchObject({ pushed: false, branch: placeholder });
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(placeholder);
  });

  it("steps past a name that is on the remote, checked out here, or ruled out by an earlier PR", async () => {
    await remote(repo);
    const other = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "other"), "claude/chat-status-2", "main"); // another thread, not pushed
    await write(join(other, "b.txt"), "b\n");
    const first = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "first"), "beam/first", "main");
    await write(join(first, "c.txt"), "c\n");
    await landRepo(first, "beam/first", "main", "Taken", { to: "claude/chat-status" }); // now on the remote

    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), placeholder, "main");
    await write(join(wt, "a.txt"), "one\n");
    const r = await landRepo(wt, placeholder, "main", "Run 1", { to: "claude/chat-status", taken: async (name) => name === "claude/chat-status-3" });
    expect(r.branch).toBe("claude/chat-status-4");
  });

  it("keeps the name of a branch that is already on the remote", async () => {
    await remote(repo);
    const wt = await ensureRepoWorktree(repo, join(root, "machine-a", "t", "app"), placeholder, "main");
    await write(join(wt, "a.txt"), "one\n");
    await landRepo(wt, placeholder, "main", "Run 1");
    await write(join(wt, "a.txt"), "two\n");
    const r = await landRepo(wt, placeholder, "main", "Run 2", { to: "claude/chat-status" });
    expect(r).toMatchObject({ pushed: true, branch: placeholder });
    expect(await remoteHead(repo, "claude/chat-status")).toBe("");
  });
});
