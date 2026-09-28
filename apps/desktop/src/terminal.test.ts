import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psQuote, windowsTerminalScript } from "./terminal";

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
});
