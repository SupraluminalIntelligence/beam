import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface RunnerConfig { convexUrl: string; token: string; githubLogin: string; name: string }
export const beamHome = () => process.env["BEAM_HOME"] ?? join(homedir(), ".beam");
const file = () => join(beamHome(), "runner.json");

export const DEFAULT_CONVEX_URL = "https://cautious-fish-858.convex.cloud";
export function convexUrl(): string {
  return process.env["BEAM_CONVEX_URL"] ?? process.env["VITE_CONVEX_URL"] ?? DEFAULT_CONVEX_URL;
}
/** The site URL hosts the /runner/device/* HTTP actions. Convex: cloud → site. */
export const siteUrl = (cloud: string) => cloud.replace(".convex.cloud", ".convex.site");

export async function readConfig(): Promise<RunnerConfig | null> {
  try { return JSON.parse(await readFile(file(), "utf8")) as RunnerConfig; } catch { return null; }
}
export async function writeConfig(c: RunnerConfig): Promise<void> {
  await mkdir(beamHome(), { recursive: true });
  await writeFile(file(), JSON.stringify(c, null, 2));
  await chmod(file(), 0o600);
}
const legacyName = () => `${process.env["USER"] ?? "me"}@${hostname().replace(/\.local$/, "")}`;
/** Use macOS's human-readable Computer Name, not its network hostname. */
export function defaultName(): string {
  if (platform() === "darwin") {
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (name) return name.slice(0, 80);
    } catch { /* Headless hosts may not have a Computer Name. */ }
  }
  return hostname().replace(/\.local$/, "").replace(/[-_]+/g, " ").trim().slice(0, 80) || "My computer";
}
/** Upgrade the old generated label while preserving explicit CLI names. Server-side aliases win. */
export const machineName = (configured: string) => configured === legacyName() ? defaultName() : configured;
