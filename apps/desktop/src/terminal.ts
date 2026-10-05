import { execFile, spawn } from "node:child_process";

export const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
export const shQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/**
 * A provider sign-in as a short shell script, so Terminal shows a titled window with one line about
 * what is happening instead of the long command that runs it. The script removes itself, runs the
 * sign-in, and says how it went.
 */
export function signInScript(provider: string, account: string, env: Record<string, string>, argv: string[]): string {
  const title = `Beam · Sign in to ${provider}`;
  return [
    "#!/bin/sh",
    'rm -f "$0"',
    `printf '\\033]0;%s\\007' ${shQuote(title)}`,
    "clear",
    `printf '\\n  %s\\n  %s\\n\\n' ${shQuote(title)} ${shQuote(account)}`,
    `${Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join(" ")} ${argv.map(shQuote).join(" ")}`,
    "status=$?",
    `if [ "$status" -eq 0 ]; then printf '\\n  Signed in. You can close this window and go back to Beam.\\n\\n'; else printf '\\n  Sign-in did not finish. Close this window and try again from Beam.\\n\\n'; fi`,
    "",
  ].join("\n");
}
export function windowsTerminalScript(command: string): string {
  // Explorer and Beam may predate a CLI installation. Refresh PATH in the new terminal.
  return `$env:Path = (@([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User'), $env:Path, (Join-Path $env:USERPROFILE '.local\\bin'), (Join-Path $env:APPDATA 'npm')) | Where-Object { $_ }) -join ';'; ${command}`;
}

export async function openTerminal(command: string): Promise<void> {
  if (process.platform === "win32") {
    const encoded = Buffer.from(windowsTerminalScript(command), "utf16le").toString("base64");
    // Start-Process creates a visible interactive console. A detached child with ignored stdio
    // can otherwise run with no usable console when Beam was started from Explorer.
    const launch = `Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${encoded}')`;
    await new Promise<void>((resolve, reject) => execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launch], { windowsHide: true }, error => error ? reject(new Error("Could not open PowerShell for provider setup.")) : resolve()));
    return;
  }
  const child = process.platform === "darwin"
    ? spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`])
    : spawn("x-terminal-emulator", ["-e", "sh", "-c", command], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not open a terminal for provider setup.")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
