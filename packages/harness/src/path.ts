import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A desktop app launched from Finder does not inherit the shell PATH, so `claude`
 * and `codex` installed via nvm or Homebrew are invisible. Ask the login shell
 * once and merge its PATH into ours. Idea borrowed from T3 Code's os-jank.ts.
 */
export async function hydratePathFromLoginShell(): Promise<string> {
  if (process.platform === "win32") return process.env["PATH"] ?? "";
  const shell = process.env["SHELL"] || "/bin/zsh";
  try {
    const { stdout } = await run(shell, ["-ilc", "printf '%s' \"$PATH\""], { timeout: 4000 });
    const found = stdout.trim();
    if (found) {
      const merged = Array.from(new Set([...found.split(":"), ...(process.env["PATH"] ?? "").split(":")])).filter(Boolean);
      process.env["PATH"] = merged.join(":");
    }
  } catch {
    // keep whatever PATH we had
  }
  return process.env["PATH"] ?? "";
}

export async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", [bin], { timeout: 2000 });
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
