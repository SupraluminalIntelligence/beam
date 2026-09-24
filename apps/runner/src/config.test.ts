import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:os", () => ({ homedir: () => "/tmp", hostname: () => "apeks-mb-pro.local", platform: vi.fn(() => "darwin") }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "Apek’s MacBook Pro\n") }));
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { defaultName, machineName } from "./config";
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(platform).mockReturnValue("darwin"); vi.mocked(execFileSync).mockReturnValue("Apek’s MacBook Pro\n"); });
it("uses the Mac Computer Name and upgrades the old generated label", () => {
  vi.stubEnv("USER", "apekshik");
  expect(defaultName()).toBe("Apek’s MacBook Pro");
  expect(machineName("apekshik@apeks-mb-pro")).toBe("Apek’s MacBook Pro");
  expect(machineName("Office workstation")).toBe("Office workstation");
});
it("falls back to a readable hostname when the system name is unavailable", () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error("not set"); });
  expect(defaultName()).toBe("apeks mb pro");
  vi.mocked(platform).mockReturnValue("linux");
  expect(defaultName()).toBe("apeks mb pro");
});
