/** Pure translation of a GitHub pull request (GraphQL) into what a change row stores. No Convex functions here. */
import { z } from "zod";

export type CheckState = "passed" | "failed" | "pending" | "skipped";
export type CheckItem = { name: string; state: CheckState; url: string | null };
export type ChecksSummary = {
  state: "pending" | "passing" | "failing" | "none";
  passed: number; failed: number; pending: number; skipped: number;
  items: CheckItem[];
  checkedAt: number;
};

/** The query behind a sync: the PR, its head commit, and a page of the checks on it. */
export const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
  state merged isDraft title url additions deletions changedFiles headRefOid
  commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{
    __typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}
  }}}}}}}}}`;
/** Matrix CI can exceed a page; past this many pages the rollup state still keeps the overall verdict right. */
export const MAX_CHECK_PAGES = 5;

const CheckRun = z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullable(), detailsUrl: z.string().nullable() });
const StatusContext = z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string(), targetUrl: z.string().nullable() });
const Context = z.discriminatedUnion("__typename", [CheckRun, StatusContext]);
export type RollupContext = z.infer<typeof Context>;
const Pr = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]), merged: z.boolean(), isDraft: z.boolean(), title: z.string(), url: z.string(),
  additions: z.number(), deletions: z.number(), changedFiles: z.number(), headRefOid: z.string(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({
    statusCheckRollup: z.object({
      state: z.string(),
      contexts: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(z.unknown()) }),
    }).nullable(),
  }) })) }),
});
const Response = z.object({
  data: z.object({ repository: z.object({ pullRequest: Pr.nullable() }).nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** What one sync learned, already checked. Crosses from the action into the mutation. */
export type PrSnapshot = {
  state: "OPEN" | "CLOSED" | "MERGED"; merged: boolean; isDraft: boolean; title: string; url: string;
  additions: number; deletions: number; changedFiles: number; headRefOid: string;
  rollupState: string | null; items: CheckItem[];
};
export type PrPage = { pr: PrSnapshot; next: string | null };

/** GitHub's response, validated. Anything malformed is an error here rather than a bad row later. */
export function parsePrPage(json: unknown): PrPage | { error: string } {
  const r = Response.safeParse(json);
  if (!r.success) return { error: `unexpected GitHub response: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}` };
  const pr = r.data.data?.repository?.pullRequest;
  if (!pr) return { error: r.data.errors?.[0]?.message ?? "pull request not found" };
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  // Other node types can appear as empty objects when no fragment matches; they carry no check.
  const items = (rollup?.contexts.nodes ?? []).flatMap((n) => { const c = Context.safeParse(n); return c.success ? [checkItem(c.data)] : []; });
  const { commits: _, ...rest } = pr;
  return {
    pr: { ...rest, rollupState: rollup?.state ?? null, items },
    next: rollup?.contexts.pageInfo.hasNextPage ? rollup.contexts.pageInfo.endCursor : null,
  };
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const SKIPPED = new Set(["SKIPPED", "STALE"]);
const ORDER: Record<CheckState, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

export function checkState(c: RollupContext): CheckState {
  if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "passed" : FAILED.has(c.state) ? "failed" : "pending";
  if (c.status !== "COMPLETED" || !c.conclusion) return "pending";
  return FAILED.has(c.conclusion) ? "failed" : SKIPPED.has(c.conclusion) ? "skipped" : "passed";
}
const checkItem = (c: RollupContext): CheckItem => ({
  name: c.__typename === "CheckRun" ? c.name : c.context,
  state: checkState(c),
  url: (c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl) || null,
});

/**
 * Failing first, then running, so the few checks worth reading sit at the top. GitHub's rollup state covers every
 * check, including any past the pages read, so it can only make the verdict worse, never better.
 */
export function summarizeChecks(all: readonly CheckItem[], rollupState: string | null, now: number): ChecksSummary {
  const items = [...all].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const count = (s: CheckState) => items.filter((i) => i.state === s).length;
  const passed = count("passed"), failed = count("failed"), pending = count("pending"), skipped = count("skipped");
  let state: ChecksSummary["state"] = failed ? "failing" : pending ? "pending" : passed + skipped ? "passing" : "none";
  if (rollupState === "FAILURE" || rollupState === "ERROR") state = "failing";
  else if ((rollupState === "PENDING" || rollupState === "EXPECTED") && state !== "failing") state = "pending";
  return { state, passed, failed, pending, skipped, items: items.slice(0, 50), checkedAt: now };
}

/** What a sync writes onto the change, and whether the PR has left the open state. */
export function prPatch(pr: PrSnapshot, now: number) {
  return {
    resolved: pr.merged || pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : null,
    patch: { title: pr.title, prUrl: pr.url, draft: pr.isDraft, headSha: pr.headRefOid, add: pr.additions, del: pr.deletions, files: pr.changedFiles, checks: summarizeChecks(pr.items, pr.rollupState, now) },
  };
}

/** Right after a push, poll every 30s while checks run. CI can take a few polls to register; after that, silence means no CI. */
export const POLL_MS = 30_000;
export function keepPolling(checks: ChecksSummary["state"], attempt: number): boolean {
  if (attempt >= 60) return false;
  return checks === "pending" || (checks === "none" && attempt < 4);
}
