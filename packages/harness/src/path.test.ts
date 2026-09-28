import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { which, cliInvocation } from "./path.ts";
import { cliVersion } from "./version.ts";
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "win32")("Windows npm CLI resolution", () => {
  it("skips Unix shims and runs the npm JS entry without shell argument expansion", async () => {
    const root = await mkdtemp(join(tmpdir(), "beam-cli-")); roots.push(root);
    const bin = join(root, "space and O'Brien"); await mkdir(bin);
    await writeFile(join(bin, "beam-fixture"), "#!/bin/sh\nexit 1\n");
    await writeFile(join(bin, "beam-fixture.cmd"), '@echo off\nnode "%dp0%\\entry.cjs" %*\n');
    const script = join(bin, "entry.cjs");
    await writeFile(script, 'console.log(process.argv[2] === "--version" ? "fixture 1.2.3" : JSON.stringify({args: process.argv.slice(2), home: process.env.CODEX_HOME}));');
    vi.stubEnv("PATH", `${bin};${process.env.PATH}`);
    const found = await which("beam-fixture");
    expect(found, "Windows CLI discovery should resolve the npm fixture").not.toBeNull();
    expect(await realpath(found!)).toBe(await realpath(script));
    const args = ["login", "O'Brien & %PATH% $(echo no)"];
    const command = cliInvocation(script, args, { ...process.env, CODEX_HOME: join(root, "isolated account") });
    const result = JSON.parse((await run(command.bin, command.args, { env: command.env, windowsHide: true })).stdout);
    expect(result).toEqual({ args, home: join(root, "isolated account") });
    expect(await cliVersion(script)).toBe("1.2.3");
  }, 20_000);
});
