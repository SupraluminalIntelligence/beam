import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psQuote, signInScript, windowsTerminalScript } from "./terminal";

// PowerShell cold start on a fresh CI runner can exceed vitest's 5 s default.
it.skipIf(process.platform !== "win32")("PowerShell preserves executable paths, profile paths and login arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "beam-terminal-"));
  try {
    const script = join(root, "O'Brien login.cjs");
    await writeFile(script, "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,path:process.env.PATH}));");
    const home = join(root, "O'Brien & work");
    const command = windowsTerminalScript(`$env:CODEX_HOME=${psQuote(home)}; & ${[process.execPath, script, "connection-login", "codex", "default"].map(psQuote).join(" ")}`);
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true });
    const value = JSON.parse(stdout.trim());
    expect(value.args).toEqual(["connection-login", "codex", "default"]);
    expect(value.home).toBe(home);
    expect(value.path).toContain(".local\\bin");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(process.platform === "win32")("signs in through a titled script that removes itself and says how it went", async () => {
  const root = await mkdtemp(join(tmpdir(), "beam it's-a-dir "));
  const run = async (argv: string[]) => {
    const file = join(root, "sign-in.sh");
    await writeFile(file, signInScript("Claude", "Default account", { BEAM_TEST: "it's set" }, argv), { mode: 0o700 });
    const out = await promisify(execFile)("sh", [file], { env: { ...process.env, TERM: "dumb" } }).then(r => r.stdout, (e: { stdout: string }) => e.stdout);
    return { out, gone: await access(file).then(() => false, () => true) };
  };
  try {
    const ok = await run(["/bin/sh", "-c", 'printf "provider sees: %s\\n" "$BEAM_TEST"', "a b"]);
    expect(ok.out).toContain("Beam · Sign in to Claude");
    expect(ok.out).toContain("Default account");
    expect(ok.out).toContain("provider sees: it's set");
    expect(ok.out).toContain("Signed in. You can close this window");
    expect(ok.gone).toBe(true);
    expect((await run(["/bin/sh", "-c", "exit 3"])).out).toContain("Sign-in did not finish");
  } finally { await rm(root, { recursive: true, force: true }); }
});
