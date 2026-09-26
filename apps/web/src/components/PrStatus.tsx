import { useAction, useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";

type Change = Doc<"changes">;
type Checks = NonNullable<Change["checks"]>;

export const openHref = (href: string) => { const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam; if (b?.openExternal) b.openExternal(href); else window.open(href, "_blank", "noopener"); };

const CI_WORD: Record<Checks["state"], string> = { passing: "passing", failing: "failing", pending: "running", none: "no checks" };
export const ciWord = (checks: Change["checks"]) => (checks ? CI_WORD[checks.state] : "checking");

export function CiDot({ checks }: { checks: Change["checks"] }) {
  return <span className={`ci-dot ${checks?.state ?? "unknown"}`} aria-hidden="true" />;
}

/** The message "Ask to fix" puts in the composer. A person still sends it. */
export function fixPrompt(handle: string, c: Pick<Change, "repo" | "prNumber" | "checks">) {
  const failing = c.checks?.items.filter((i) => i.state === "failed").map((i) => i.name) ?? [];
  return `@${handle} CI is failing on ${c.repo}#${c.prNumber} (${failing.slice(0, 5).join(", ")}${failing.length > 5 ? ", …" : ""}). Read the failing checks and push a fix.`;
}

const ago = (t: number, now: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

/** Open PRs in the thread, pinned above the composer: number, branch, size, and CI with its checks one click away. */
export function PrBar({ changes, askHandle, onAsk }: { changes: Change[]; askHandle: string | null; onAsk: (text: string) => void }) {
  const open = changes.filter((c) => c.state === "open");
  if (!open.length) return null;
  return <div className="prbar" aria-label="Open pull requests">{open.map((c) => <PrRow key={c._id} change={c} askHandle={askHandle} onAsk={onAsk} />)}</div>;
}

/** Where a change stands on GitHub, for its icon. */
export type PrState = "branch" | "draft" | "open" | "merged" | "closed";
export const prState = (c: Pick<Change, "state" | "prNumber" | "draft">): PrState =>
  c.state === "merged" ? "merged" : c.state === "closed" ? "closed" : !c.prNumber ? "branch" : c.draft ? "draft" : "open";
const PR_STATE_WORD: Record<PrState, string> = { branch: "Branch pushed, no PR yet", draft: "Draft PR", open: "Open PR", merged: "Merged", closed: "Closed" };

export function PrIcon({ state }: { state: PrState }) {
  const side = state === "draft" ? <><path d="M12 4.5v.01M12 8v.01" /><circle cx="12" cy="12.5" r="1.75" /></>
    : state === "closed" ? <><path d="m10.5 3.5 3 3m0-3-3 3M12 9v1.75" /><circle cx="12" cy="12.5" r="1.75" /></>
    : state === "merged" ? <><path d="M4 5.25c0 3 3.5 3.25 6.25 3.25" /><circle cx="12" cy="8.5" r="1.75" /></>
    : state === "branch" ? <><path d="M12 6.25c0 3.25-8 2.25-8 4.5" /><circle cx="12" cy="4.5" r="1.75" /></>
    : <><path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.5" /><path d="M9 3 7.5 4.5 9 6" /><circle cx="12" cy="12.5" r="1.75" /></>;
  return (
    <svg className={`pr-icon ${state}`} viewBox="0 0 16 16" role="img" aria-label={PR_STATE_WORD[state]}>
      <title>{PR_STATE_WORD[state]}</title>
      <circle cx="4" cy="3.5" r="1.75" /><circle cx="4" cy="12.5" r="1.75" /><path d="M4 5.25v5.5" />{side}
    </svg>
  );
}

/** Closes whichever popover is open on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("click", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", esc); };
  }, [open]);
}

const errText = (e: unknown) => String((e as Error).message).replace(/^.*Uncaught Error: /, "");

function PrRow({ change: c, askHandle, onAsk }: { change: Change; askHandle: string | null; onAsk: (text: string) => void }) {
  const [open, setOpen] = useState<"ci" | "branch" | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = useMutation(api.changes.refresh);
  const createPr = useAction(api.github.createPr);
  useDismiss(open !== null, () => setOpen(null));
  const toggleCi = () => {
    if (open !== "ci") void refresh({ changeId: c._id }).catch((e) => toast(errText(e)));
    setOpen(open === "ci" ? null : "ci");
  };
  const create = () => {
    setCreating(true);
    createPr({ changeId: c._id })
      .then((r) => { if ("error" in r) toast(r.error); else toast("PR opened"); })
      .catch((e) => toast(errText(e)))
      .finally(() => setCreating(false));
  };
  const href = c.prUrl;
  const branchUrl = `https://github.com/${c.repo}/tree/${c.branch.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <div className="prrow">
      <PrIcon state={prState(c)} />
      {c.prNumber && href && <button className="prnum" onClick={() => openHref(href)} title={`Open ${c.title} on GitHub`}>#{c.prNumber}</button>}
      <span className="prrepo">{c.repo.split("/")[1]}</span>
      <div className="prbranchwrap" onClick={(e) => e.stopPropagation()}>
        <button className="prbranch" aria-expanded={open === "branch"} aria-haspopup="menu" onClick={() => setOpen(open === "branch" ? null : "branch")} title={c.branch}>{c.branch}</button>
        {open === "branch" && (
          <div className="prmenu" role="menu">
            <button role="menuitem" onClick={() => { setOpen(null); void navigator.clipboard.writeText(c.branch).then(() => toast("Branch name copied"), () => toast("Couldn't copy the branch name")); }}>Copy branch name</button>
            <button role="menuitem" onClick={() => { setOpen(null); openHref(branchUrl); }}>Open branch on GitHub</button>
          </div>
        )}
      </div>
      <span className="add">+{c.add}</span><span className="del">−{c.del}</span>
      {c.prNumber && href ? (
        <div className="ci" onClick={(e) => e.stopPropagation()}>
          <button className={`cichip ${c.checks?.state ?? "unknown"}`} aria-expanded={open === "ci"} aria-haspopup="dialog" onClick={toggleCi} title={`CI ${ciWord(c.checks)}`}>
            <CiDot checks={c.checks} />CI<span className="chev" aria-hidden="true">▾</span>
          </button>
          {open === "ci" && <CiPopover change={c} href={href} askHandle={askHandle} onAsk={(t) => { setOpen(null); onAsk(t); }} />}
        </div>
      ) : <button className="cichip create" disabled={creating} onClick={create}>{creating ? "Creating…" : "Create PR"}</button>}
    </div>
  );
}

export function CiPopover({ change: c, href, askHandle, onAsk }: { change: Change; href: string; askHandle: string | null; onAsk: (text: string) => void }) {
  const k = c.checks;
  const counts = k ? ([["failed", "Failed", k.failed], ["pending", "Running", k.pending], ["passed", "Passed", k.passed], ["skipped", "Skipped", k.skipped]] as const).filter(([, , n]) => n > 0) : [];
  const worth = k?.items.filter((i) => i.state === "failed" || i.state === "pending").slice(0, 8) ?? [];
  return (
    <div className="cipop" role="dialog" aria-label={`CI for #${c.prNumber}`}>
      <div className="cih"><span>CI checks</span><button className="cilink" onClick={() => openHref(`${href}/checks`)} title="Open checks on GitHub">↗</button></div>
      {!k && <div className="cinote">Checking GitHub…</div>}
      {k?.state === "none" && <div className="cinote">No checks reported on the latest commit.</div>}
      {counts.map(([state, label, n]) => <div key={state} className={`cicount ${state}`}><span className={`ci-mark ${state}`} aria-hidden="true" /><span>{label}</span><span className="n">{n}</span></div>)}
      {worth.length > 0 && <div className="ciitems">{worth.map((i, n) => (
        <button key={`${i.name}-${n}`} className={`ciitem ${i.state}`} disabled={!i.url} onClick={() => i.url && openHref(i.url)} title={i.url ? "Open the log" : undefined}>
          <span className={`ci-mark ${i.state}`} aria-hidden="true" /><span className="nm">{i.name}</span>
        </button>
      ))}</div>}
      <div className="cift">
        {!!k?.failed && askHandle && <button className="ciask" onClick={() => onAsk(fixPrompt(askHandle, c))}>Ask @{askHandle} to fix</button>}
        <button onClick={() => openHref(href)}>Open PR</button>
        {k && <span className="ciago">updated {ago(k.checkedAt, Date.now())}</span>}
      </div>
    </div>
  );
}
