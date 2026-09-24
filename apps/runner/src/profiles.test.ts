import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageProfiles, profileFor, readProfiles } from "./profiles";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "beam-profile-")); directories.push(dir); vi.stubEnv("BEAM_HOME", dir); return dir; }

it("creates isolated named profiles and persists a default without copying authentication", async () => {
  const dir = await fixture();
  const a = await manageProfiles({ action: "create", harness: "codex", name: "Work" });
  const b = await manageProfiles({ action: "create", harness: "codex", name: "Personal" });
  expect(b.profiles).toHaveLength(2);
  expect(b.profiles[0]!.configDir).not.toBe(b.profiles[1]!.configDir);
  await manageProfiles({ action: "default", harness: "codex", id: a.profiles[0]!.id });
  expect((await readProfiles()).defaults.codex).toBe(a.profiles[0]!.id);
  expect(await readFile(join(dir, "connections.json"), "utf8")).not.toContain("auth.json");
  expect(await profileFor("codex", a.profiles[0]!.id)).toEqual({ configDir: a.profiles[0]!.configDir });
  await expect(profileFor("claude", a.profiles[0]!.id)).rejects.toThrow("missing");
});
it("rejects duplicate aliases, relative paths and using the existing default as a separate account", async () => {
  const dir = await fixture(); const profile = join(dir, "work"); await mkdir(profile);
  await expect(manageProfiles({ action: "add", harness: "claude", name: "Work", configDir: "relative" })).rejects.toThrow("absolute");
  vi.stubEnv("CLAUDE_CONFIG_DIR", profile);
  await expect(manageProfiles({ action: "add", harness: "claude", name: "Work", configDir: profile })).rejects.toThrow("already the default");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "other"));
  await manageProfiles({ action: "add", harness: "claude", name: "Work", configDir: profile });
  const alias = join(dir, "alias"); await symlink(profile, alias);
  await expect(manageProfiles({ action: "add", harness: "claude", name: "Other", configDir: alias })).rejects.toThrow("already connected");
  await expect(manageProfiles({ action: "default", harness: "codex", id: "missing" })).rejects.toThrow("Unknown");
});
