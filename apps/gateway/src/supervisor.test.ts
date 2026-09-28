import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_ABANDONED, SUPERVISOR, TIMED_OUT } from "./supervisor.ts";

/** Runs the real entrypoint script under bash, with the job and work directories in a temp folder. */
let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))); dirs = []; });

async function start(env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "beam-supervisor-")); dirs.push(root);
  const job = join(root, "job"), work = join(root, "work");
  const child = spawn("bash", ["-c", SUPERVISOR], {
    env: { PATH: process.env["PATH"]!, BEAM_JOB_DIR: job, BEAM_WORK: work, BEAM_HOLD_SECONDS: "0", BEAM_TIMEOUT: "30", ...env },
    stdio: "ignore",
  });
  const exited = new Promise<number>(resolve => child.once("exit", code => resolve(code ?? -1)));
  const until = async (path: string) => { for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise(r => setTimeout(r, 25)); };
  await until(job);
  return { job, work, exited, until };
}

describe("sandbox supervisor", () => {
  it("waits for go, runs the command in the work directory and records its log and exit code", async () => {
    const s = await start({ BEAM_COMMAND: "pwd; echo out; echo err >&2; exit 3" });
    await writeFile(join(s.job, "go"), "");
    expect(await s.exited).toBe(0);
    expect(await readFile(join(s.job, "exit"), "utf8")).toBe("3");
    const log = await readFile(join(s.job, "log"), "utf8");
    expect(log).toContain(s.work);
    expect(log).toContain("out");
    expect(log).toContain("err");
  });

  it("does not start the command until go, and never after abort", async () => {
    const s = await start({ BEAM_COMMAND: "touch ran" });
    await new Promise(r => setTimeout(r, 300));
    expect(existsSync(join(s.work, "ran"))).toBe(false);
    await writeFile(join(s.job, "abort"), "");
    expect(await s.exited).toBe(0);
    expect(existsSync(join(s.work, "ran"))).toBe(false);
    expect(existsSync(join(s.job, "exit"))).toBe(false);
  });

  it("gives up when no go arrives within the launch window", async () => {
    const s = await start({ BEAM_COMMAND: "touch ran", BEAM_LAUNCH_WINDOW: "1" });
    expect(await s.exited).toBe(LAUNCH_ABANDONED);
    expect(existsSync(join(s.work, "ran"))).toBe(false);
  }, 10_000);

  it("stops a command that runs past its time limit", async () => {
    const s = await start({ BEAM_COMMAND: "sleep 20", BEAM_TIMEOUT: "1" });
    await writeFile(join(s.job, "go"), "");
    expect(await s.exited).toBe(0);
    expect(await readFile(join(s.job, "exit"), "utf8")).toBe(String(TIMED_OUT));
  }, 10_000);
});
