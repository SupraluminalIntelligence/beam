export const HARNESS_INFO: Record<string, { vendor: string; models: string[]; min: string; files: string }> = {
  claude: { vendor: "Anthropic", models: ["Fable 5.1", "Fable 5.0", "Opus 5.0", "Sonnet 5.0"], min: "Claude Code ≥ 2.4", files: "CLAUDE.md, AGENTS.md" },
  codex: { vendor: "OpenAI", models: ["GPT-6 Astra", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"], min: "Codex CLI ≥ 0.151", files: "AGENTS.md" },
  omp: { vendor: "via omp · pick a provider", models: ["GPT-5.6 Sol", "Kimi K3", "Gemini 3.5 Pro", "Claude Opus 5 (API key)"], min: "omp ≥ 1.0", files: "AGENTS.md, .omp/" },
};
