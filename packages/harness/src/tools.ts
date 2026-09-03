/** One-line, human-readable summaries of tool calls. Shared by every adapter. */
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const rel = (p: unknown, cwd: string) => (typeof p === "string" ? (p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p) : "");

export function describeTool(name: string, input: Record<string, unknown>, cwd: string): { kind: string; summary: string } {
  const i = input ?? {};
  switch (name) {
    case "Bash": return { kind: "bash", summary: short(String(i["command"] ?? "").replace(/\s+/g, " ")) };
    case "Read": return { kind: "read", summary: `Read ${rel(i["file_path"], cwd)}` };
    case "Edit": return { kind: "edit", summary: `Edit ${rel(i["file_path"], cwd)}` };
    case "Write": return { kind: "write", summary: `Write ${rel(i["file_path"], cwd)}` };
    case "NotebookEdit": return { kind: "edit", summary: `Edit ${rel(i["notebook_path"], cwd)}` };
    case "Grep": return { kind: "search", summary: `Grep ${short(String(i["pattern"] ?? ""), 50)}${i["path"] ? ` in ${rel(i["path"], cwd)}` : ""}` };
    case "Glob": return { kind: "search", summary: `Glob ${String(i["pattern"] ?? "")}` };
    case "LS": return { kind: "read", summary: `List ${rel(i["path"], cwd) || "."}` };
    case "WebFetch": return { kind: "web", summary: `Fetch ${short(String(i["url"] ?? ""), 70)}` };
    case "WebSearch": return { kind: "web", summary: `Search ${short(String(i["query"] ?? ""), 60)}` };
    case "Agent": case "Task": return { kind: "agent", summary: `Subagent · ${short(String(i["description"] ?? i["prompt"] ?? ""), 70)}` };
    case "TodoWrite": return { kind: "plan", summary: "Update todo list" };
    case "ToolSearch": return { kind: "plan", summary: "Look up tools" };
    case "EnterPlanMode": return { kind: "plan", summary: "Start planning" };
    case "ExitPlanMode": return { kind: "plan", summary: "Present the plan" };
    case "AskUserQuestion": return { kind: "ask", summary: "Ask a question" };
    case "mcp__beam__attach_repo": return { kind: "beam", summary: `Attach ${String(i["repo"] ?? "")} to this chat` };
    case "mcp__beam__list_repos": return { kind: "beam", summary: "List the workspace's repos" };
    default: return { kind: name.toLowerCase(), summary: `${name} ${short(JSON.stringify(i), 60)}` };
  }
}

/** Does a tool call match an "always allow" entry? Entries are tool names ("Edit") or Bash command prefixes ("git status"). */
export function matchesAllow(name: string, input: Record<string, unknown>, allow: readonly string[]): boolean {
  if (name.startsWith("mcp__beam__")) return true; // Beam's own tools never prompt
  for (const a of allow) {
    if (a === name || a === "*") return true;
    if (name === "Bash") {
      const cmd = String(input?.["command"] ?? "").trim();
      if (cmd === a || cmd.startsWith(a + " ") || cmd.startsWith(a + "\n")) return true;
    }
  }
  return false;
}

export const truncate = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

/** Commands that still deserve a human even in auto mode. Everything else auto mode allows. */
const DANGER = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, /\brm\s+-rf?\s+[\/~]/i, /\bsudo\b/, /\bgit\s+push\b.*(--force|-f\b)/, /\bgit\s+reset\s+--hard/, /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+branch\s+-D\b/, /\bdrop\s+(table|database)\b/i, /\bmkfs\b/, /\bdd\s+if=/, /\bchmod\s+-R\s+777/, /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/, /\bwget\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bkill\s+-9\s+-1\b/, /\bshutdown\b/, /\breboot\b/, /\blaunchctl\s+(unload|remove)/, /\bdefaults\s+write\b/, /\bsecurity\s+(delete|set)/, /\bnpm\s+publish\b/, /\bcargo\s+publish\b/, /\bpypi\b/,
];
export function isDangerous(name: string, input: Record<string, unknown>): boolean {
  if (name !== "Bash") return false;
  const cmd = String(input?.["command"] ?? "");
  return DANGER.some((re) => re.test(cmd));
}
