import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (args: string[], cwd?: string) => run("git", args, cwd ? { cwd } : {}).then((r) => r.stdout.trim());

export const beamHome = () => process.env["BEAM_HOME"] ?? join(homedir(), ".beam");
/** Tests point this at a local directory of bare repos ("file:///tmp/x/"). */
const gitBase = () => process.env["BEAM_GIT_BASE"] ?? "https://github.com/";
export const remoteUrl = (repo: string) => `${gitBase()}${repo}.git`;
export const mirrorPath = (repo: string) => join(beamHome(), "repos", `${repo.replace("/", "-")}.git`);
export const worktreePath = (workspaceId: string, chatId: string) => join(beamHome(), "worktrees", workspaceId, chatId);

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * One bare clone per repo per machine, with ordinary remote-tracking refs (origin/main). Worktrees hang off it,
 * so they share objects and see the same origin. Not a --mirror: those push every ref and refuse refspecs.
 */
export async function ensureMirror(repo: string): Promise<string> {
  const path = mirrorPath(repo);
  if (!(await exists(path))) {
    await mkdir(join(beamHome(), "repos"), { recursive: true });
    await git(["clone", "--bare", remoteUrl(repo), path]);
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], path);
  }
  await git(["fetch", "--prune", "origin"], path);
  return path;
}

/** The remote's default branch, read from the mirror's HEAD. */
export async function defaultBranch(repo: string): Promise<string> {
  const mirror = mirrorPath(repo);
  const ref = await git(["symbolic-ref", "--short", "HEAD"], mirror).catch(() => "main");
  const name = ref.replace(/^origin\//, "") || "main";
  const ok = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], mirror).catch(() => "");
  if (ok) return name;
  for (const c of ["main", "master"]) if (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${c}`], mirror).catch(() => "")) return c;
  return name;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
/** beam/<chat-title>-<6 chars of the run id>. Fixed for the chat until it rotates on merge. */
export const branchName = (title: string, runId: string) => `beam/${slug(title)}-${runId.slice(-6).toLowerCase()}`;

/** One worktree per chat, on the chat's active branch. Created from the mirror, never copied between machines. */
export async function ensureWorktree(repo: string, workspaceId: string, chatId: string, branch: string, base = "main"): Promise<string> {
  const mirror = await ensureMirror(repo);
  const wt = worktreePath(workspaceId, chatId);
  const localHas = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], mirror).catch(() => "");
  const remoteHas = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], mirror).catch(() => "");
  if (await exists(wt)) {
    const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], wt).catch(() => "");
    if (current !== branch) {
      if (localHas) await git(["checkout", branch], wt);
      else await git(["checkout", "-b", branch, remoteHas ? `origin/${branch}` : `origin/${base}`], wt);
    }
    return wt;
  }
  await mkdir(join(beamHome(), "worktrees", workspaceId), { recursive: true });
  if (localHas) await git(["worktree", "add", wt, branch], mirror);
  else await git(["worktree", "add", "-b", branch, wt, remoteHas ? `origin/${branch}` : `origin/${base}`], mirror);
  return wt;
}

/** A run always ends with a push, even on interrupt or failure. */
export async function checkpointAndPush(wt: string, branch: string, message: string): Promise<{ committed: boolean }> {
  await git(["add", "-A"], wt);
  const dirty = await git(["status", "--porcelain"], wt);
  if (dirty) await git(["-c", "user.name=Beam", "-c", "user.email=beam@supraluminal.dev", "commit", "-m", message], wt);
  await git(["push", "-u", "origin", branch], wt);
  return { committed: !!dirty };
}

/** A draft PR through the user's own `gh` login, if there is one. Beam holds no GitHub token. */
export async function draftPullRequest(wt: string, repo: string, branch: string, base: string, title: string, body: string): Promise<string | null> {
  try {
    const { stdout } = await run("gh", ["pr", "create", "--draft", "--repo", repo, "--head", branch, "--base", base, "--title", title, "--body", body], { cwd: wt, env: process.env });
    const m = stdout.match(/https:\/\/\S+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}
export const compareUrl = (repo: string, base: string, branch: string) => `https://github.com/${repo}/compare/${base}...${encodeURIComponent(branch)}?expand=1`;

export async function diffStat(wt: string, base = "origin/main"): Promise<{ add: number; del: number; files: number }> {
  const out = await git(["diff", "--numstat", `${base}...HEAD`], wt);
  let add = 0, del = 0, files = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t");
    add += Number(a) || 0; del += Number(d) || 0; files += 1;
  }
  return { add, del, files };
}
