export const HARNESS: Record<string, { name: string; glyph: string }> = {
  claude: { name: "Claude Code", glyph: "✱" }, codex: { name: "Codex", glyph: "◯" }, omp: { name: "omp", glyph: "◆" },
};

export const LIVE = ["queued", "starting", "working", "landing"];
export const isLive = (state: string) => LIVE.includes(state);

/** Whose account a run uses: the account owner the runner reported, else whoever dispatched it. */
export function ownerOf(run: { execution?: { accountOwner: string } | null; dispatchedBy: string }): string {
  return run.execution?.accountOwner || run.dispatchedBy;
}

/** "Your Claude Code", "Noah's Codex". Agents are named by whose account they run on. */
export function agentName(harness: string, owner: string, me: string, nameOf: (login: string) => string): string {
  const who = owner === me ? "Your" : `${nameOf(owner).split(" ")[0]}'s`;
  return `${who} ${HARNESS[harness]?.name ?? harness}`;
}

export type ChatStatus = { state: "waiting" | "working" | "failed" | "none"; agent: string | null; since: number | null };

/** What a chat row says when you are away. Waiting beats working beats a failure; otherwise nothing. */
export function chatStatus(runs: { state: string; startedAt: number | null; _creationTime: number; label: string }[], waiting: boolean): ChatStatus {
  const last = [...runs].sort((a, b) => b._creationTime - a._creationTime)[0];
  if (waiting && last) return { state: "waiting", agent: last.label, since: null };
  const live = runs.find((r) => isLive(r.state));
  if (live) return { state: "working", agent: live.label, since: live.startedAt ?? live._creationTime };
  if (last && (last.state === "failed" || last.state === "interrupted")) return { state: "failed", agent: last.label, since: null };
  return { state: "none", agent: null, since: null };
}
