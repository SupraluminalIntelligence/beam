import { expect, it } from "vitest";
import { profileEnv } from "./profile";

it("isolates concurrent Codex profiles without mutating the parent or inheriting its API key", () => {
  const parent = { CODEX_HOME: "/original", OPENAI_API_KEY: "secret", PATH: "/bin" };
  const work = profileEnv("codex", { configDir: "/work" }, parent);
  const personal = profileEnv("codex", { configDir: "/personal" }, parent);
  expect(work.CODEX_HOME).toBe("/work"); expect(personal.CODEX_HOME).toBe("/personal");
  expect(work.OPENAI_API_KEY).toBeUndefined(); expect(work.PATH).toBe("/bin");
  expect(parent).toEqual({ CODEX_HOME: "/original", OPENAI_API_KEY: "secret", PATH: "/bin" });
});
it("isolates Claude authentication and provider overrides but preserves the default CLI environment", () => {
  const parent = { CLAUDE_CONFIG_DIR: "/original", CLAUDE_CODE_OAUTH_TOKEN: "secret", ANTHROPIC_API_KEY: "key", CLAUDE_CODE_USE_BEDROCK: "1" };
  const explicit = profileEnv("claude", { configDir: "/work" }, parent);
  expect(explicit).toEqual({ CLAUDE_CONFIG_DIR: "/work" });
  expect(profileEnv("claude", undefined, parent)).toEqual(parent);
});
