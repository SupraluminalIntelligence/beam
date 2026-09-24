import { expect, it } from "vitest";
import type { ActivityLine } from "@beam/reducer";
import { activityLabel, activitySummary } from "./activity";

const step = (summary: string, kind = "beam", ok: boolean | null = true): ActivityLine => ({ itemId: summary, kind, summary, detail: null, ok, ms: 100, startedAt: 1 });

it("describes saved Beam calls without implying that the computation finished", () => {
  expect(activitySummary([step("get_job"), step("run_simulation")]).text).toBe("Check job status · Start simulation job");
  expect(activityLabel(step("validate_simulation"))).toBe("Validate simulation setup");
  expect(activityLabel(step("run_simulation", "beam", false))).toBe("Start simulation job");
  expect(activityLabel(step("run_simulation", "beam", null))).toBe("Start simulation job");
});

it("recognizes Claude's namespaced Beam events too", () => {
  expect(activityLabel(step('mcp__beam__get_job {"id":"job1"}', "mcp__beam__get_job"))).toBe("Check job status");
});

it("groups repeated polling while retaining other actions", () => {
  expect(activitySummary([step("get_job"), step("get_job"), step("run_simulation")]).text).toBe("Check job status ×2 · Start simulation job");
});

it("bounds mixed previews and retains every action in the full description", () => {
  const summary = activitySummary([step("list_simulations"), step("validate_simulation"), step("save_simulation"), step("run_simulation")]);
  expect(summary.text).toBe("List simulation studies · Validate simulation setup · +2 more");
  expect(summary.full).toBe("List simulation studies · Validate simulation setup · Save simulation study · Start simulation job");
});

it("preserves commands, paths, unknown tools, and custom Beam summaries", () => {
  expect(activityLabel(step("pnpm test", "bash"))).toBe("pnpm test");
  expect(activityLabel(step("Read src/main.ts", "read"))).toBe("Read src/main.ts");
  expect(activityLabel(step("custom_tool input", "beam"))).toBe("custom_tool input");
  expect(activityLabel(step("Save Triangle flow · r2", "beam"))).toBe("Save Triangle flow · r2");
  expect(activityLabel(step("get_job", "bash"))).toBe("get_job");
  expect(activitySummary([])).toEqual({ text: "", full: "" });
});

it("replaces long shell previews with grouped actions while preserving commands in details", () => {
  const command = 'cd supraluminal && grep -rln "underdetermined\\|oneInternalFace\\|triangulat" --include=*.ts .';
  const calls = [step(command, "bash"), step('grep -rlnE "underdetermined|checkMesh|cdt|triangulat" . 2>/dev/null | grep -v node_modules', "bash")];
  expect(activitySummary(calls).text).toBe("Search project files ×2");
  expect(activityLabel(calls[0]!)).toBe(command);
});

it("keeps unfamiliar commands concise and does not classify quoted command names", () => {
  expect(activitySummary([step('echo "grep -r foo ."', "bash")]).text).toBe("Run shell command");
  expect(activitySummary([step("python script.py", "bash")]).text).toBe("Run shell command");
  expect(activitySummary([step("pnpm test", "bash"), step("git diff --stat", "bash")]).text).toBe("Run tests · Review code changes");
});
