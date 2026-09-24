export type HarnessProfile = { configDir: string };

/** Per-child configuration. Never mutate the runner's environment or switch a global login. */
export function profileEnv(harness: "codex" | "claude", profile?: HarnessProfile, source = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (!profile) return env;
  // Explicit profiles use their own provider authentication, never a parent process's token.
  const keys = harness === "codex"
    ? ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_AUTH_JSON"]
    : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  for (const key of keys) delete env[key];
  env[harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = profile.configDir;
  return env;
}
