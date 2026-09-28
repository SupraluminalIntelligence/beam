/** A review comment Beam asks an agent to address: an unresolved thread on the diff, or a review that requested changes. */
export type ReviewComment = { id: string; path: string | null; line: number | null; author: string | null; body: string; url: string | null };

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The message that asks an agent to fix a PR: its failing checks, the review comments it hasn't been asked about, or
 * both. "Ask to fix" puts it in the composer for a person to send; auto-fix sends it as the person who turned it on.
 */
export function fixRequest(handle: string, pr: { repo: string; prNumber: number | null }, failing: readonly string[] | null, comments: readonly ReviewComment[] = []) {
  const ref = `${pr.repo}#${pr.prNumber}`;
  const parts: string[] = [];
  if (failing) {
    const names = failing.length ? ` (${failing.slice(0, 5).join(", ")}${failing.length > 5 ? ", …" : ""})` : "";
    parts.push(`CI is failing on ${ref}${names}. Read the failing checks and push a fix.`);
  }
  if (comments.length) {
    const lines = comments.slice(0, 10).map((c) => `- ${c.path ? `${c.path}${c.line ? `:${c.line}` : ""} ` : ""}${c.author ? `(${c.author}) ` : ""}${clip(c.body, 300)}${c.url ? ` ${c.url}` : ""}`);
    const more = comments.length > 10 ? `\n- …and ${comments.length - 10} more on the PR` : "";
    parts.push(`${failing ? "Also address" : "Address"} ${comments.length === 1 ? "this review comment" : "these review comments"} on ${ref}:\n${lines.join("\n")}${more}`);
  }
  return `@${handle} ${parts.join("\n\n")}`;
}
