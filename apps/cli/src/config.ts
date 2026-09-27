import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_URL } from "@beam/worlds";

/** The CLI's one file: an app token for this machine, readable only by you. Beside, never inside, runner.json. */
export interface WorldsConfig { convexUrl: string; token: string; login: string; name: string; scopes: string[] }
export const beamHome = () => process.env["BEAM_HOME"] ?? join(homedir(), ".beam");
export const configFile = () => join(beamHome(), "layer.json");

export async function readConfig(): Promise<WorldsConfig | null> {
  try { return JSON.parse(await readFile(configFile(), "utf8")) as WorldsConfig; } catch { return null; }
}
export async function writeConfig(c: WorldsConfig): Promise<void> {
  await mkdir(beamHome(), { recursive: true });
  await writeFile(configFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(configFile(), 0o600);
}
export const forgetConfig = () => rm(configFile(), { force: true });

export function convexUrl(saved?: WorldsConfig | null): string {
  return process.env["BEAM_CONVEX_URL"] ?? saved?.convexUrl ?? DEFAULT_URL;
}
/** HTTP actions (device login) live on the site host. */
export const siteUrl = (cloud: string) => cloud.replace(".convex.cloud", ".convex.site");

/** BEAM_TOKEN wins, so a world can run somewhere `beam login` never ran. */
export async function credentials(): Promise<{ token: string; url: string } | null> {
  const saved = await readConfig();
  const token = process.env["BEAM_TOKEN"] ?? saved?.token;
  return token ? { token, url: convexUrl(saved) } : null;
}
