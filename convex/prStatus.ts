/** Pure translation of a GitHub pull request (GraphQL) into what a change row stores. No Convex functions here. */

export type CheckState = "passed" | "failed" | "pending" | "skipped";
export type ChecksSummary = {
  state: "pending" | "passing" | "failing" | "none";
  passed: number; failed: number; pending: number; skipped: number;
  items: { name: string; state: CheckState; url: string | null }[];
  checkedAt: number;
};

type CheckRun = { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl: string | null };
type StatusContext = { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };
export type RollupContext = CheckRun | StatusContext;

export type GitHubPr = {
  state: "OPEN" | "CLOSED" | "MERGED"; merged: boolean; isDraft: boolean; title: string;
  additions: number; deletions: number; changedFiles: number; headRefOid: string;
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: (RollupContext | Record<string, never>)[] } } | null } }[] };
};

/** The query behind `prPatch`: one round trip for the PR, its head commit, and every check on it. */
export const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  state merged isDraft title additions deletions changedFiles headRefOid
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
    __typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}
  }}}}}}}}}`;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const SKIPPED = new Set(["SKIPPED", "STALE"]);
const ORDER: Record<CheckState, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

export function checkState(c: RollupContext): CheckState {
  if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "passed" : FAILED.has(c.state) ? "failed" : "pending";
  if (c.status !== "COMPLETED" || !c.conclusion) return "pending";
  return FAILED.has(c.conclusion) ? "failed" : SKIPPED.has(c.conclusion) ? "skipped" : "passed";
}

/** Failing first, then running, so the few checks worth reading sit at the top. */
export function summarizeChecks(contexts: readonly RollupContext[], now: number): ChecksSummary {
  const items = contexts.map((c) => ({
    name: c.__typename === "CheckRun" ? c.name : c.context,
    state: checkState(c),
    url: (c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl) || null,
  })).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const count = (s: CheckState) => items.filter((i) => i.state === s).length;
  const passed = count("passed"), failed = count("failed"), pending = count("pending"), skipped = count("skipped");
  const state = failed ? "failing" : pending ? "pending" : passed + skipped ? "passing" : "none";
  return { state, passed, failed, pending, skipped, items: items.slice(0, 50), checkedAt: now };
}

/** What a sync writes onto the change, and whether the PR has left the open state. */
export function prPatch(pr: GitHubPr, now: number) {
  const contexts = (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c): c is RollupContext => "__typename" in c);
  return {
    resolved: pr.merged || pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : null,
    patch: { title: pr.title, draft: pr.isDraft, headSha: pr.headRefOid, add: pr.additions, del: pr.deletions, files: pr.changedFiles, checks: summarizeChecks(contexts, now) },
  };
}

/** Right after a push, poll every 30s while checks run. CI can take a few polls to register; after that, silence means no CI. */
export const POLL_MS = 30_000;
export function keepPolling(checks: ChecksSummary["state"], attempt: number): boolean {
  if (attempt >= 60) return false;
  return checks === "pending" || (checks === "none" && attempt < 4);
}
