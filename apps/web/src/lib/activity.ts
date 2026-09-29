import type { ActivityLine } from "@beam/reducer";

const BEAM_ACTIONS: Record<string, string> = {
  list_simulations: "List simulations",
  validate_simulation: "Validate simulation setup",
  select_simulation: "Select simulation study",
  save_simulation: "Save simulation study",
  run_simulation: "Start simulation job",
  compare_simulation_runs: "Compare simulation runs",
  mesh_convergence: "Estimate mesh convergence",
  import_simulation_model: "Import 3-D model",
  save_version: "Save simulation version",
  run_version: "Run simulation version",
  compare_versions: "Compare simulation versions",
  list_jobs: "List compute jobs",
  get_job: "Check job status",
  cancel_job: "Request job cancellation",
  submit_job: "Submit compute job",
  job_submit: "Submit compute job",
  results_read: "Read job results",
  environment_list: "List environments",
  machine_open: "Open machine",
  machine_exec: "Run on machine",
  machine_close: "Stop the machine",
  machine_show: "Show a picture",
  list_sources: "List chat sources",
  read_source: "Read chat source",
  list_files: "List chat files",
  read_file: "Read chat file",
  share_file: "Share file",
  list_repos: "List the workspace's repos",
  attach_repo: "Attach repo",
  adopt_pr: "Adopt pull request",
  new_pr: "Start a new pull request",
  describe_change: "Describe the change",
};

/** A string field from JSON that may have been cut off mid-value. */
function jsonField(json: string, field: string): string {
  const raw = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json)?.[1] ?? "";
  let value: string;
  try { value = JSON.parse(`"${raw}"`) as string; } catch { value = raw.replace(/\\n/g, " ").replace(/\\(.)/g, "$1"); }
  return value.replace(/\s+/g, " ").trim();
}

/** "fea", or a pinned image such as ghcr.io/…/beam-env-fea@sha256:… → "fea". */
const environmentName = (env: string) => (/[/@:]/.test(env) ? env.split("@")[0]!.split("/").pop()!.split(":")[0]!.replace(/^beam-env-/, "") : env) || "a";

/**
 * Claude's MCP calls saved before the harness named them carry the raw tool name as their kind and
 * "mcp__beam__machine_exec {json…}" as their summary. Read them the way the harness now writes them.
 */
export function normalized(a: Pick<ActivityLine, "kind" | "summary">): { kind: string; summary: string } {
  // Codex names a Beam tool call by the tool alone.
  if (a.kind === "beam" && a.summary.trim() === "machine_show") return { kind: "show", summary: "Show a picture" };
  const m = a.kind.startsWith("mcp__") ? /^mcp__(.+?)__(\S+)\s*([\s\S]*)$/.exec(a.summary.trim()) : null;
  if (!m) return a;
  const [, server, tool, args] = m as unknown as [string, string, string, string];
  if (server !== "beam") return { kind: "tool", summary: `${server} · ${tool} ${args}`.trim() };
  if (tool === "machine_exec") return { kind: "machine", summary: jsonField(args, "command") || tool };
  if (tool === "machine_show") return { kind: "show", summary: jsonField(args, "caption") || "Show a picture" };
  if (tool === "machine_open") {
    const env = jsonField(args, "environment");
    return { kind: "beam", summary: env && !env.endsWith("…") ? `Open ${environmentName(env)} machine` : tool }; // a name cut off in the summary says nothing
  }
  return { kind: "beam", summary: tool };
}

/** Presentation only: also makes saved tool events readable without rewriting history. */
export function activityLabel(line: Pick<ActivityLine, "kind" | "summary">): string {
  const a = normalized(line);
  if (a.kind === "beam") {
    const name = a.summary.trim().split(/\s/)[0] ?? "";
    if (BEAM_ACTIONS[name]) return BEAM_ACTIONS[name];
  }
  return a.summary.trim() || `${a.kind} tool call`;
}

/** Summarize shell activity without putting source code in the disclosure heading. */
function overviewLabel(line: ActivityLine): string {
  const a = normalized(line);
  if (a.kind === "machine") return "Run on machine";
  if (a.kind === "show") return "Show a picture";
  if (a.kind === "tool") return /^\S+ · \S+/.exec(a.summary)?.[0] ?? activityLabel(a);
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
