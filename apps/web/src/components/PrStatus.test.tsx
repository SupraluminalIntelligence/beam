import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("convex/react", () => ({ useMutation: () => async () => {}, useAction: () => async () => {} }));
import type { Doc } from "../../../../convex/_generated/dataModel";
import { CiPopover, PrBar, fixPrompt, prState } from "./PrStatus";
import { LandingCard } from "./RunBlocks";

const change = (over: Record<string, unknown> = {}) => ({
  _id: "c1", _creationTime: 0, chatId: "chat", workspaceId: "ws", repo: "acme/beam", branch: "beam/delete-workspace", base: "main", state: "open",
  title: "Add workspace deletion", prUrl: "https://github.com/acme/beam/pull/12", prNumber: 12, add: 137, del: 11, files: 6, adopted: false,
  createdBy: "me", updatedAt: 0, resolvedAt: null,
  checks: { state: "failing", passed: 2, failed: 1, pending: 0, skipped: 1, checkedAt: Date.now(), items: [
    { name: "test", state: "failed", url: "https://ci/test" }, { name: "lint", state: "passed", url: null }, { name: "typecheck", state: "passed", url: null }, { name: "docs", state: "skipped", url: null },
  ] },
  ...over,
}) as Doc<"changes">;

describe("PrBar", () => {
  it("shows each open PR's number, branch, size and CI state, and nothing for resolved ones", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change(), change({ _id: "c2" as never, state: "merged", prNumber: 9 })]} askHandle="claude" onAsk={() => {}} />);
    expect(html).toContain("#12");
    expect(html).not.toContain("#9");
    expect(html).toContain("beam/delete-workspace");
    expect(html).toContain("+137");
    expect(html).toContain('class="cichip failing"');
  });

  it("renders nothing when no PR is open", () => {
    expect(renderToStaticMarkup(<PrBar changes={[change({ state: "closed" })]} askHandle={null} onAsk={() => {}} />)).toBe("");
  });

  it("offers Create PR for a branch without one, instead of CI", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change({ prNumber: null, prUrl: null, checks: undefined })]} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain("Create PR");
    expect(html).toContain('class="pr-icon branch"');
    expect(html).not.toContain("cichip failing");
  });

  it("drops the CI chip when GitHub reports no checks, but keeps it until GitHub has been read", () => {
    const none = renderToStaticMarkup(<PrBar changes={[change({ checks: { ...change().checks!, state: "none", passed: 0, failed: 0, skipped: 0, items: [] } })]} askHandle={null} onAsk={() => {}} />);
    expect(none).not.toContain("cichip");
    expect(renderToStaticMarkup(<PrBar changes={[change({ checks: undefined })]} askHandle={null} onAsk={() => {}} />)).toContain('class="cichip unknown"');
  });

  it("colors the icon by where the PR stands", () => {
    expect(prState(change())).toBe("open");
    expect(prState(change({ draft: true }))).toBe("draft");
    expect(prState(change({ prNumber: null }))).toBe("branch");
    expect(prState(change({ state: "merged" }))).toBe("merged");
    expect(prState(change({ state: "closed" }))).toBe("closed");
  });
});

describe("CiPopover", () => {
  const c = change();
  it("counts checks, lists the failing ones, and offers the fix prompt", () => {
    const html = renderToStaticMarkup(<CiPopover change={c} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />);
    expect(html).toMatch(/Failed<\/span><span class="n">1/);
    expect(html).toMatch(/Passed<\/span><span class="n">2/);
    expect(html).not.toContain("Running");
    expect(html).toContain('<span class="nm">test</span>');
    expect(html).not.toContain('<span class="nm">lint</span>');
    expect(html).toContain("Ask @claude to fix");
  });

  it("says when checks can't be read instead of checking forever, and links to the PR as View PR", () => {
    const html = renderToStaticMarkup(<CiPopover change={change({ checks: undefined })} href={c.prUrl!} error="Server Error" askHandle="claude" onAsk={() => {}} />);
    expect(html).toContain("can&#x27;t read this PR&#x27;s checks");
    expect(html).not.toContain("Checking GitHub");
    expect(html).toContain(">View PR<");
  });

  it("does not offer a fix while CI passes", () => {
    const passing = change({ checks: { ...c.checks!, state: "passing", failed: 0, items: c.checks!.items.slice(1) } });
    expect(renderToStaticMarkup(<CiPopover change={passing} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />)).not.toContain("to fix");
  });

  it("writes a fix prompt that mentions the agent and names the failing checks", () => {
    expect(fixPrompt("codex", c)).toBe("@codex CI is failing on acme/beam#12 (test). Read the failing checks and push a fix.");
  });
});

describe("LandingCard", () => {
  const landing = (over: Record<string, unknown> = {}) => ({ repo: "acme/beam", branch: "beam/delete-workspace", base: "main", pushed: true, add: 137, del: 11, files: 6, prUrl: "https://github.com/acme/beam/pull/12", compareUrl: null, error: null, ...over });
  const card = (state: string, repo: Record<string, unknown>, changes: Doc<"changes">[]) =>
    renderToStaticMarkup(<LandingCard run={{ state, landing: { error: null, repos: [landing(repo)] } } as never} changes={changes} />);

  it("is one line that names the PR, without repeating the branch or CI from the bar", () => {
    const html = card("landed", {}, [change()]);
    expect(html).toContain("pushed to beam#12");
    expect(html).toContain("+137");
    expect(html).not.toContain("beam/delete-workspace<");
    expect(html).not.toContain("CI");
  });

  it("says when the PR has merged, since the bar no longer shows it", () => {
    expect(card("landed", {}, [change({ state: "merged" })])).toMatch(/pr-icon merged.*>merged</);
  });

  it("says when a stopped run pushed nothing", () => {
    expect(card("interrupted", { pushed: false, prUrl: null }, [])).toContain("stopped · nothing pushed to beam");
  });
});
