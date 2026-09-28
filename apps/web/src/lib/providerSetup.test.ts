import { expect, it } from "vitest";
import { providerInstall } from "./providerSetup";
it("uses PowerShell-compatible setup on Windows", () => {
  expect(providerInstall("claude", "win32")).toBe("irm https://claude.ai/install.ps1 | iex");
  expect(providerInstall("codex", "win32")).toContain("npm.cmd install -g @openai/codex");
  expect(providerInstall("codex", "win32")).toContain("Install Node.js LTS");
  expect(providerInstall("omp", "win32")).toBeNull();
  expect(providerInstall("omp", "darwin")).toContain("| sh");
});
