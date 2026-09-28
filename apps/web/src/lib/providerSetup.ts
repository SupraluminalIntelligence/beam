/** Commands are for the selected machine, which may differ from this browser's platform. */
export function providerInstall(harness: string, platform: string): string | null {
  if (platform === "win32") {
    if (harness === "claude") return "irm https://claude.ai/install.ps1 | iex";
    if (harness === "codex") return "if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { npm.cmd install -g @openai/codex } else { Write-Error 'Install Node.js LTS from https://nodejs.org, then click Install again in Beam.' }";
    return null;
  }
  return ({ claude: "npm i -g @anthropic-ai/claude-code", codex: "npm i -g @openai/codex", omp: "curl -fsSL https://omp.sh/install | sh" } as Record<string, string>)[harness] ?? null;
}
