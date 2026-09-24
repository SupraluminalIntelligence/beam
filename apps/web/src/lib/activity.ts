import type { ActivityLine } from "@beam/reducer";

const BEAM_ACTIONS: Record<string, string> = {
  list_simulations: "List simulation studies",
  validate_simulation: "Validate simulation setup",
  select_simulation: "Select simulation study",
  save_simulation: "Save simulation study",
  run_simulation: "Start simulation job",
  compare_simulation_runs: "Compare simulation runs",
  list_jobs: "List compute jobs",
  get_job: "Check job status",
  cancel_job: "Request job cancellation",
  submit_job: "Submit compute job",
};

/** Presentation only: also makes saved tool events readable without rewriting history. */
export function activityLabel(a: Pick<ActivityLine, "kind" | "summary">): string {
  if (a.kind === "beam" || a.kind.startsWith("mcp__beam__")) {
    const name = a.summary.trim().replace(/^mcp__beam__/, "").split(/\s/)[0] ?? "";
    if (BEAM_ACTIONS[name]) return BEAM_ACTIONS[name];
  }
  return a.summary.trim() || `${a.kind} tool call`;
}

/** Summarize shell activity without putting source code in the disclosure heading. */
function overviewLabel(a: ActivityLine): string {
  if (a.kind !== "bash") return activityLabel(a);
  // Ignore a leading directory change; otherwise classify only the first executable.
  // Unknown or compound shell syntax stays generic rather than guessing its purpose.
  const command = a.summary.trim().replace(/^cd\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s*&&\s*/, "");
  if (/^(?:rg|grep|find|fd)\s/.test(command)) return "Search project files";
  if (/^(?:cat|head|tail)\s/.test(command)) return "Read files";
  if (/^ls(?:\s|$)/.test(command)) return "List files";
  if (/^git\s+(?:diff|show|log)(?:\s|$)/.test(command)) return "Review code changes";
  if (/^git\s+status(?:\s|$)/.test(command)) return "Check working tree";
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/.test(command)) return "Run tests";
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)/.test(command)) return "Build project";
  return "Run shell command";
}

/** Keep a compact preview, with the complete list available as the header tooltip. */
export function activitySummary(activity: readonly ActivityLine[]): { text: string; full: string } {
  const counts = new Map<string, number>();
  for (const a of activity) {
    const label = overviewLabel(a);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts].map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
  return {
    text: labels.slice(0, 2).join(" · ") + (labels.length > 2 ? ` · +${labels.length - 2} more` : ""),
    full: labels.join(" · "),
  };
}
