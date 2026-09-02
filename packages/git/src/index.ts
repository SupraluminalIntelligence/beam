import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (args: string[], cwd?: string) => run("git", args, cwd ? { cwd } : {}).then((r) => r.stdout.trim());

export const beamHome = () => process.env["BEAM_HOME"] ?? join(homedir(), ".beam");
export const mirrorPath = (repo: string) => join(beamHome(), "repos", `${repo.replace("/", "-")}.git`);
export const worktreePath = (workspaceId: string, chatId: string) => join(beamHome(), "worktrees", workspaceId, chatId);

const exists = (p: string) => stat(p).then(() => true, () => false);

/** One bare mirror per repo per machine. Cloned once, fetched after. */
export async function ensureMirror(repo: string): Promise<string> {
  const path = mirrorPath(repo);
  if (!(await exists(path))) {
    await mkdir(join(beamHome(), "repos"), { recursive: true });
    await git(["clone", "--mirror", `https://github.com/${repo}.git`, path]);
  } else {
    await git(["fetch", "--prune"], path);
  }
  return path;
}

/** One worktree per chat, on the chat's active branch. Created from the mirror, never copied between machines. */
export async function ensureWorktree(repo: string, workspaceId: string, chatId: string, branch: string, base = "main"): Promise<string> {
  const mirror = await ensureMirror(repo);
  const wt = worktreePath(workspaceId, chatId);
  if (await exists(wt)) {
    await git(["fetch", "origin"], wt).catch(() => {});
    await git(["checkout", branch], wt).catch(() => git(["checkout", "-b", branch, `origin/${base}`], wt));
    return wt;
  }
  await mkdir(join(beamHome(), "worktrees", workspaceId), { recursive: true });
  const remoteHas = await git(["branch", "--list", branch], mirror);
  if (remoteHas) await git(["worktree", "add", wt, branch], mirror);
  else await git(["worktree", "add", "-b", branch, wt, base], mirror);
  return wt;
}

/** A run always ends with a push, even on interrupt or failure. */
export async function checkpointAndPush(wt: string, branch: string, message: string): Promise<void> {
  await git(["add", "-A"], wt);
  const dirty = await git(["status", "--porcelain"], wt);
  if (dirty) await git(["commit", "-m", message], wt);
  await git(["push", "-u", "origin", branch], wt);
}

export async function diffStat(wt: string, base = "origin/main"): Promise<{ add: number; del: number; files: number }> {
  const out = await git(["diff", "--numstat", `${base}...HEAD`], wt);
  let add = 0, del = 0, files = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t");
    add += Number(a) || 0; del += Number(d) || 0; files += 1;
  }
  return { add, del, files };
}
