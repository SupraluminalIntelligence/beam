import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
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
export const defaultName = () => `${process.env["USER"] ?? "me"}@${hostname().replace(/\.local$/, "")}`;
