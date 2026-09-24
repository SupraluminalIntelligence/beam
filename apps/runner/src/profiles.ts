import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adapters } from "@beam/harness";
import { beamHome } from "./config.ts";

const Harness = z.enum(["codex", "claude"]);
const Profile = z.object({ id: z.string(), harness: Harness, name: z.string().trim().min(1).max(80), configDir: z.string() });
const Config = z.object({ profiles: z.array(Profile), defaults: z.record(z.string()).default({}) });
export type Profile = z.infer<typeof Profile>;
const file = () => join(beamHome(), "connections.json");
export async function readProfiles(): Promise<z.infer<typeof Config>> {
  try { return Config.parse(JSON.parse(await readFile(file(), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [], defaults: {} }; throw new Error("Could not read Beam connection profiles. Fix connections.json before starting a run."); }
}
export async function profileFor(harness: string, id = "default") {
  if (id === "default") return undefined;
  const profile = (await readProfiles()).profiles.find(p => p.harness === harness && p.id === id);
  if (!profile) throw new Error("Selected local account profile is missing. Choose another connection.");
  return { configDir: await realpath(profile.configDir) };
}
export async function probeProfiles() {
  const config = await readProfiles();
  const statuses = await Promise.all(Object.values(adapters).map(async a => ({ ...(await a.probe()), connectionId: "default", connectionName: "Default account", isDefault: !config.defaults[a.kind] || config.defaults[a.kind] === "default" })));
  for (const p of config.profiles) {
    const status = await adapters[p.harness].probe({ configDir: p.configDir });
    statuses.push({ ...status, connectionId: p.id, connectionName: p.name, isDefault: config.defaults[p.harness] === p.id });
  }
  return statuses;
}
export const ProfileCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("add"), harness: Harness, name: z.string().trim().min(1).max(80), configDir: z.string().min(1) }),
  z.object({ action: z.literal("create"), harness: Harness, name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("default"), harness: Harness, id: z.string() }),
]);
export async function manageProfiles(input: unknown) {
  const command = ProfileCommand.parse(input);
  const config = await readProfiles();
  if (command.action === "add" || command.action === "create") {
    const id = randomUUID();
    const directory = command.action === "create" ? join(beamHome(), "profiles", command.harness, id) : command.configDir;
    if (!isAbsolute(directory)) throw new Error("Choose an absolute profile directory.");
    if (command.action === "create") await mkdir(directory, { recursive: true, mode: 0o700 });
    const configDir = await realpath(directory);
    if (!(await stat(configDir)).isDirectory()) throw new Error("Choose a profile directory");
    const inherited = command.harness === "codex" ? process.env["CODEX_HOME"] ?? join(homedir(), ".codex") : process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
    if (await realpath(inherited).catch(() => inherited) === configDir) throw new Error("This directory is already the default CLI connection. Choose a separate profile.");
    if (config.profiles.some(p => p.harness === command.harness && p.configDir === configDir)) throw new Error("This profile directory is already connected.");
    config.profiles.push({ id, harness: command.harness, name: command.name, configDir });
  } else if (command.action === "default") {
    if (command.id !== "default" && !config.profiles.some(p => p.id === command.id && p.harness === command.harness)) throw new Error("Unknown profile");
    config.defaults[command.harness] = command.id;
  }
  if (command.action !== "list") {
    await mkdir(beamHome(), { recursive: true });
    const temp = `${file()}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600); await rename(temp, file());
  }
  return config;
}
