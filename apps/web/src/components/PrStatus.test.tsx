import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("convex/react", () => ({ useMutation: () => async () => {}, useAction: () => async () => {} }));
import type { Doc } from "../../../../convex/_generated/dataModel";
import { CiPopover, PrBar, PrCard, fixPrompt, prState } from "./PrStatus";
import { LandingCard } from "./RunBlocks";

const comment = (id: string) => ({ id, path: "src/page.tsx", line: 4, author: "noah", body: "Handle the empty case", url: "https://github.com/acme/beam/pull/12#r1" });
const change = (over: Record<string, unknown> = {}) => ({
  _id: "c1", _creationTime: 0, chatId: "chat", workspaceId: "ws", repo: "acme/beam", branch: "beam/delete-workspace", base: "main", state: "open",
  title: "Add workspace deletion", prUrl: "https://github.com/acme/beam/pull/12", prNumber: 12, add: 137, del: 11, files: 6, adopted: false,
  createdBy: "me", updatedAt: 0, resolvedAt: null, draft: false,
  checks: { state: "failing", passed: 2, failed: 1, pending: 0, skipped: 1, checkedAt: Date.now(), items: [
    { name: "test", state: "failed", url: "https://ci/test" }, { name: "lint", state: "passed", url: null }, { name: "typecheck", state: "passed", url: null }, { name: "docs", state: "skipped", url: null },
  ] },
  ...over,
}) as Doc<"changes">;

describe("PrBar", () => {
  it("shows each open PR's number, title, size and CI state, and nothing for resolved ones", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change(), change({ _id: "c2" as never, state: "merged", prNumber: 9 })]} askHandle="claude" onAsk={() => {}} />);
    expect(html).toContain("#12");
    expect(html).not.toContain("#9");
    expect(html).toContain(">Add workspace deletion</button>");
    expect(html).toContain('title="beam/delete-workspace"');
    expect(html).toContain("+137");
    expect(html).toContain('class="cichip failing"');
  });

  it("shows a PR that has a number but no stored URL, linking to it on GitHub", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change({ prUrl: null })]} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain("#12");
    expect(html).toContain("cichip failing");
    expect(html).not.toContain("Create PR");
  });

  it("says a PR is out of date when GitHub can't be read, with the reason on hover", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change({ syncError: "Beam's GitHub access has expired." })]} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain('<span class="prstale" title="Beam&#x27;s GitHub access has expired.">out of date</span>');
    expect(renderToStaticMarkup(<PrBar changes={[change()]} askHandle={null} onAsk={() => {}} />)).not.toContain("out of date");
  });

  it("renders nothing when no PR is open", () => {
    expect(renderToStaticMarkup(<PrBar changes={[change({ state: "closed" })]} askHandle={null} onAsk={() => {}} />)).toBe("");
  });

  it("offers Create PR for a branch without one, instead of CI", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change({ prNumber: null, prUrl: null, checks: undefined })]} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain("Create PR");
    expect(html).toContain('class="pr-icon branch"');
    expect(html).not.toContain("cichip failing");
    expect(html).toContain(">beam/delete-workspace</button>");
  });

  it("keeps the CI chip on a PR with no checks, since its automation lives there too", () => {
    const none = renderToStaticMarkup(<PrBar changes={[change({ checks: { ...change().checks!, state: "none", passed: 0, failed: 0, skipped: 0, items: [] } })]} askHandle={null} onAsk={() => {}} />);
    expect(none).toContain('class="cichip none"');
    expect(renderToStaticMarkup(<PrBar changes={[change({ checks: undefined })]} askHandle={null} onAsk={() => {}} />)).toContain('class="cichip unknown"');
  });

  it("counts unresolved review comments beside CI, and shows nothing when there are none", () => {
    const html = renderToStaticMarkup(<PrBar changes={[change({ comments: [comment("t1"), comment("t2")] })]} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain('title="2 unresolved review comments · open on GitHub"');
    expect(renderToStaticMarkup(<PrBar changes={[change({ comments: [] })]} askHandle={null} onAsk={() => {}} />)).not.toContain("cichip comments");
  });

  it("colors the icon by where the PR stands", () => {
    expect(prState(change())).toBe("open");
    expect(prState(change({ draft: true }))).toBe("draft");
    expect(prState(change({ draft: undefined }))).toBe("unsynced");
    expect(prState(change({ prNumber: null }))).toBe("branch");
    expect(prState(change({ state: "merged" }))).toBe("merged");
    expect(prState(change({ state: "closed" }))).toBe("closed");
  });
});

describe("PrCard", () => {
  it("shows where the PR stands, its full title, who opened it, and its size", () => {
    const html = renderToStaticMarkup(<PrCard change={change({ author: "apekshik", openedAt: Date.now() - 9 * 60_000, title: "Plan allocated compute for physics tools" })} />);
    expect(html).toContain('class="prpill open"');
    expect(html).toContain(">Open</span>");
    expect(html).toContain("acme/beam #12");
    expect(html).toContain("9m ago");
    expect(html).toContain(">Plan allocated compute for physics tools<");
    expect(html).toContain("apekshik");
    expect(html).toContain("6 files");
  });

  it("leaves out who and when for a PR read before Beam kept them", () => {
    const html = renderToStaticMarkup(<PrCard change={change({ draft: true })} />);
    expect(html).toContain(">Draft</span>");
    expect(html).not.toContain("prcard-by");
    expect(html).not.toContain("ago");
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

  it("keeps Ask to fix when only GitHub's rollup knows of a failure, and says why no check is listed", () => {
    const rollupOnly = change({ checks: { ...c.checks!, state: "failing", failed: 0, items: c.checks!.items.slice(1) } });
    const html = renderToStaticMarkup(<CiPopover change={rollupOnly} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />);
    expect(html).toContain("Ask @claude to fix");
    expect(html).toContain("more than Beam lists");
    expect(fixPrompt("claude", rollupOnly)).toBe("@claude CI is failing on acme/beam#12. Read the failing checks and push a fix.");
  });

  it("shows why GitHub could not be read instead of checking forever", () => {
    const html = renderToStaticMarkup(<CiPopover change={change({ checks: undefined, syncError: "GitHub answered 502" })} href={c.prUrl!} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain("GitHub answered 502");
    expect(html).not.toContain("Checking GitHub");
  });

  it("marks cached CI as stale when the last GitHub read failed", () => {
    const html = renderToStaticMarkup(<CiPopover change={change({ syncError: "GitHub refused Beam's access to this PR" })} href={c.prUrl!} askHandle={null} onAsk={() => {}} />);
    expect(html).toContain("Couldn&#x27;t refresh (GitHub refused Beam&#x27;s access to this PR)");
    expect(html).toMatch(/Failed<\/span><span class="n">1/);
  });

  it("does not offer a fix while CI passes", () => {
    const passing = change({ checks: { ...c.checks!, state: "passing", failed: 0, items: c.checks!.items.slice(1) } });
    expect(renderToStaticMarkup(<CiPopover change={passing} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />)).not.toContain("to fix");
  });

  it("offers the three automations with their state, and hides them without a handler", () => {
    const on = change({ autoFix: { by: "noah", agentId: "a1", attempts: 0, addressed: [] }, autoMerge: { by: "me", note: "Waiting for checks to finish" } });
    const html = renderToStaticMarkup(<CiPopover change={on} href={c.prUrl!} askHandle="claude" onAsk={() => {}} onAuto={() => {}} handleOf={() => "claude"} />);
    expect(html).toContain("Auto-fix CI &amp; address comments");
    expect(html).toContain("@claude fixes as noah");
    expect(html).toContain("Waiting for checks to finish");
    expect(html).toContain("Settle thread on merge or close");
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<CiPopover change={c} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />)).not.toContain("Auto-merge");
  });

  it("says why auto-fix stopped, in place of who it acts as", () => {
    const stopped = change({ autoFix: { by: "noah", agentId: "a1", attempts: 3, addressed: [], note: "Stopped after 3 tries at CI." } });
    const html = renderToStaticMarkup(<CiPopover change={stopped} href={c.prUrl!} askHandle="claude" onAsk={() => {}} onAuto={() => {}} />);
    expect(html).toContain('<small class="warn">Stopped after 3 tries at CI.</small>');
  });

  it("lists open review comments and offers to fix them even while CI passes", () => {
    const passing = change({ checks: { ...c.checks!, state: "passing", failed: 0, items: c.checks!.items.slice(1) }, comments: [comment("t1")] });
    const html = renderToStaticMarkup(<CiPopover change={passing} href={c.prUrl!} askHandle="claude" onAsk={() => {}} />);
    expect(html).toContain("page.tsx:4");
    expect(html).toContain("Ask @claude to fix");
    expect(fixPrompt("claude", passing)).toBe("@claude Address this review comment on acme/beam#12:\n- src/page.tsx:4 (noah) Handle the empty case https://github.com/acme/beam/pull/12#r1");
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
