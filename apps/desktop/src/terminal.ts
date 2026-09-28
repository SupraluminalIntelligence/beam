import { execFile, spawn } from "node:child_process";

export const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
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
