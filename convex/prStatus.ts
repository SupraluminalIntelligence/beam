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
  errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).optional(),
});

/** What one sync learned, already checked. Crosses from the action into the mutation. */
export type PrSnapshot = {
  state: "OPEN" | "CLOSED" | "MERGED"; merged: boolean; isDraft: boolean; title: string; url: string;
  additions: number; deletions: number; changedFiles: number; headRefOid: string;
  rollupState: string | null; items: CheckItem[];
};
export type PrPage = { pr: PrSnapshot; next: string | null };

/**
 * GitHub's response, validated. Anything malformed is an error here rather than a bad row later. GraphQL hides a private
 * repo the token can't see as not found, so a missing repo or PR is forbidden: another member's token may read it.
 */
export function parsePrPage(json: unknown): PrPage | Refusal {
  const r = Response.safeParse(json);
  if (!r.success) return { error: `unexpected GitHub response: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`, kind: "other" };
  const pr = r.data.data?.repository?.pullRequest;
  if (!pr) {
    const errors = r.data.errors ?? [];
    const kind = errors.some((e) => e.type === "RATE_LIMITED") ? "rate-limited" : errors.every((e) => !e.type || e.type === "NOT_FOUND" || e.type === "FORBIDDEN") ? "forbidden" : "other";
    return { error: errors[0]?.message ?? "pull request not found", kind };
  }
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

/**
 * Why GitHub turned a read down. Expired means the token itself is dead (revoked, or pushed out by newer sign-ins);
 * forbidden means this token can't see the repo, which another member's might; rate-limited clears on its own.
 */
export type Refusal = { error: string; kind: "expired" | "forbidden" | "rate-limited" | "other" };
/** A one-way fingerprint of a token, so a rejected one can be recognized later without keeping a second copy of it. */
export async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const EXPIRED = "Beam's GitHub access has expired. Sign out of Beam and sign back in with GitHub to renew it.";
export function refusal(status: number, headers: { get(name: string): string | null }): Refusal {
  if (status === 401) return { error: EXPIRED, kind: "expired" };
  if ((status === 403 || status === 429) && (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null)) return { error: "GitHub is rate-limiting Beam. It will try again shortly.", kind: "rate-limited" };
  if (status === 403 || status === 404) return { error: "GitHub refused Beam's access to this PR", kind: "forbidden" };
  return { error: `GitHub answered ${status}`, kind: "other" };
}

const RestPr = z.object({ html_url: z.string().url(), number: z.number().int().positive() });
/** A PR from GitHub's REST API (the one Create PR opened, or the first of a list when one already existed), validated. */
export function parseRestPr(json: unknown): { url: string; number: number } | null {
  const one = RestPr.safeParse(Array.isArray(json) ? json[0] : json);
  return one.success ? { url: one.data.html_url, number: one.data.number } : null;
}

/** Right after a push, poll every 30s while checks run. CI can take a few polls to register; after that, silence means no CI. */
export const POLL_MS = 30_000;
export function keepPolling(checks: ChecksSummary["state"], attempt: number): boolean {
  if (attempt >= 60) return false;
  return checks === "pending" || (checks === "none" && attempt < 4);
}
