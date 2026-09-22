import { describe, expect, it } from "vitest";
import { canResume, resolveExecution, selectRunner } from "./execution";
const status = { harness: "codex", auth: "authenticated", email: "apek@example.test", plan: "Pro", models: [
  { model: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["high", "xhigh"] },
  { model: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["low", "high"] },
] };
const runner = { _id: "apek-runner", ownerLogin: "apek", online: true, lastSeen: 100000, launchedByApp: true, harnesses: [status] };
const other = { ...runner, _id: "george-runner", ownerLogin: "george", allowSharedRuns: true };
const options = { login: "apek", harness: "codex", members: ["apek", "george"], now: 100001 };
const agent = { harness: "codex", model: "GPT-5.6 Sol", effort: "high" };
describe("personal dispatch", () => {
  it("uses the author's model and freezes it independently of later preference edits", () => {
    const preferences = [{ harness: "codex", model: "GPT-6 Astra", effort: "max" }];
    const apek = resolveExecution(agent, preferences, runner);
    const george = resolveExecution(agent, [{ harness: "codex", model: "GPT-5.6 Sol", effort: "low" }], { ...other, harnesses: [{ ...status, email: "george@example.test" }] });
    preferences[0]!.model = "GPT-5.6 Sol";
    expect(apek).toMatchObject({ model: "gpt-6-astra", effort: "xhigh", accountOwner: "apek", accountEmail: "apek@example.test" });
    expect(george).toMatchObject({ model: "gpt-5.6-sol", effort: "low", accountOwner: "george", accountEmail: "george@example.test" });
  });
  it("never falls back to a teammate or somebody else's pinned runner", () => {
    expect(selectRunner([other, runner], { ...options, pinned: other._id })).toBe(runner);
    expect(() => selectRunner([other], options)).toThrow("unavailable");
  });
  it("requires an explicit choice and owner opt-in, and respects revocation", () => {
    expect(selectRunner([other], { ...options, selected: other._id })).toBe(other);
    expect(() => selectRunner([{ ...other, allowSharedRuns: false }], { ...options, selected: other._id })).toThrow("no longer shared");
    expect(() => selectRunner([other], { ...options, selected: other._id, members: ["apek"] })).toThrow();
    expect(() => selectRunner([{ ...other, lastSeen: 0 }], { ...options, selected: other._id })).toThrow();
  });
  it("rejects unavailable models and efforts instead of substituting", () => {
    expect(() => resolveExecution({ ...agent, model: "missing" }, [], runner)).toThrow("unavailable");
    expect(() => resolveExecution({ ...agent, effort: "ultra" }, [], runner)).toThrow("does not support");
    expect(() => resolveExecution(agent, [], { ...runner, harnesses: [{ ...status, models: [] }] })).toThrow("Refresh");
  });
  it("isolates resumed sessions by requester, connection, account and model", () => {
    const run = { runnerId: "r", dispatchedBy: "apek", execution: resolveExecution(agent, [], runner) };
    expect(canResume(run, run)).toBe(true);
    expect(canResume(run, { ...run, dispatchedBy: "george" })).toBe(false);
    expect(canResume(run, { ...run, runnerId: "other" })).toBe(false);
    expect(canResume(run, { ...run, execution: { ...run.execution, model: "gpt-6-astra" } })).toBe(false);
    expect(canResume(run, { ...run, execution: { ...run.execution, accountEmail: "other@example.test" } })).toBe(false);
    expect(canResume({ runnerId: "r", dispatchedBy: "apek" }, run)).toBe(false);
  });
});
