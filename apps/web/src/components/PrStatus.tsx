import { useAction, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { fixRequest } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";
import { PersonAvatar } from "./Avatar";

type Change = Doc<"changes">;
type Checks = NonNullable<Change["checks"]>;

/** A PR's page. Some changes know only their number (older rows, the demo); GitHub's URL for it is predictable. */
export const prHref = (c: Pick<Change, "repo" | "prUrl" | "prNumber">) => c.prUrl ?? (c.prNumber ? `https://github.com/${c.repo}/pull/${c.prNumber}` : null);

export const openHref = (href: string) => { const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam; if (b?.openExternal) b.openExternal(href); else window.open(href, "_blank", "noopener"); };

const CI_WORD: Record<Checks["state"], string> = { passing: "passing", failing: "failing", pending: "running", none: "no checks" };
export const ciWord = (checks: Change["checks"]) => (checks ? CI_WORD[checks.state] : "checking");

export function CiDot({ checks }: { checks: Change["checks"] }) {
  return <span className={`ci-dot ${checks?.state ?? "unknown"}`} aria-hidden="true" />;
}

/** The message "Ask to fix" puts in the composer: failing checks, open review comments, or both. A person still sends it. */
export function fixPrompt(handle: string, c: Pick<Change, "repo" | "prNumber" | "checks" | "comments">) {
  const failing = c.checks?.state === "failing" ? c.checks.items.filter((i) => i.state === "failed").map((i) => i.name) : null;
  return fixRequest(handle, c, failing, c.comments ?? []);
}

const ago = (t: number, now: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
const since = (t: number, now: number) => { const m = Math.max(0, Math.round((now - t) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

type Auto = "fix" | "merge" | "settle";
type PrProps = { askHandle: string | null; onAsk: (text: string) => void; handleOf?: (agentId: string) => string | undefined };

/** Open PRs in the thread, pinned above the composer: number, title, size, review comments, and CI with its checks and automation one click away. */
export function PrBar({ changes, ...rest }: { changes: Change[] } & PrProps) {
  const open = changes.filter((c) => c.state === "open");
  if (!open.length) return null;
  return <div className="prbar" aria-label="Open pull requests">{open.map((c) => <PrRow key={c._id} change={c} {...rest} />)}</div>;
}

/** Where a change stands on GitHub, for its icon. Until a sync has read the PR, Beam doesn't know whether it is a draft. */
export type PrState = "branch" | "unsynced" | "draft" | "open" | "merged" | "closed";
export const prState = (c: Pick<Change, "state" | "prNumber" | "draft">): PrState =>
  c.state === "merged" ? "merged" : c.state === "closed" ? "closed" : !c.prNumber ? "branch" : c.draft === undefined ? "unsynced" : c.draft ? "draft" : "open";
const PR_STATE_WORD: Record<PrState, string> = { branch: "Branch pushed, no PR yet", unsynced: "PR not read from GitHub yet", draft: "Draft PR", open: "Open PR", merged: "Merged", closed: "Closed" };
const PR_PILL: Record<PrState, string> = { branch: "Branch", unsynced: "Open", draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };

/** What hovering a PR's number shows: where it stands, its full title, who opened it and how big it is. */
export function PrCard({ change: c }: { change: Change }) {
  const st = prState(c);
  return (
    <div className="prcard" role="tooltip">
      <div className="prcard-h">
        <span className={`prpill ${st}`}><PrIcon state={st} />{PR_PILL[st]}</span>
        <span className="prcard-ref">{c.repo} #{c.prNumber}</span>
        {c.openedAt && <span className="prcard-ago">{since(c.openedAt, Date.now())}</span>}
      </div>
      <div className="prcard-t">{c.title}</div>
      <div className="prcard-f">
        {c.author && <span className="prcard-by"><PersonAvatar login={c.author} className="xs" />{c.author}</span>}
        <span className="prcard-size"><span className="add">+{c.add}</span><span className="del">−{c.del}</span></span>
        <span className="prcard-files">{c.files} file{c.files === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

/** Shows a card after the pointer rests on a PR's number, or at once on keyboard focus. */
function useHoverCard() {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return {
    shown,
    bind: {
      onMouseEnter: () => { clear(); timer.current = setTimeout(() => setShown(true), 350); },
      onMouseLeave: () => { clear(); setShown(false); },
      onFocus: () => setShown(true), onBlur: () => setShown(false),
    },
  };
}

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

function PrRow({ change: c, askHandle, onAsk, handleOf }: { change: Change } & PrProps) {
  const [open, setOpen] = useState<"ci" | "branch" | null>(null);
  const [creating, setCreating] = useState(false);
  const [ciError, setCiError] = useState<string | null>(null);
  const refresh = useMutation(api.changes.refresh);
  const setAuto = useMutation(api.changes.setAuto);
  const createPr = useAction(api.github.createPr);
  const card = useHoverCard();
  const onAuto = (kind: Auto, on: boolean) => void setAuto({ changeId: c._id, kind, on }).catch((e) => toast(errText(e)));
  useDismiss(open !== null, () => setOpen(null));
  const toggleCi = () => {
    if (open !== "ci") { setCiError(null); void refresh({ changeId: c._id }).catch((e) => setCiError(errText(e))); }
    setOpen(open === "ci" ? null : "ci");
  };
  const create = () => {
    setCreating(true);
    createPr({ changeId: c._id })
      .then((r) => { if ("error" in r) toast(r.error); else toast("PR opened"); })
      .catch((e) => toast(errText(e)))
      .finally(() => setCreating(false));
  };
  const href = prHref(c);
  const branchUrl = `https://github.com/${c.repo}/tree/${c.branch.split("/").map(encodeURIComponent).join("/")}`;
  // A PR is known by its title, which GitHub sync keeps current when an agent or a person renames it. A branch without
  // a PR has only its name. Either way the branch stays one click away.
  const label = c.prNumber ? c.title : c.branch;
  return (
    <div className="prrow">
      <PrIcon state={prState(c)} />
      {c.prNumber && href && (
        <span className="prnumwrap" {...card.bind}>
          <button className="prnum" onClick={() => openHref(href)} aria-label={`Open #${c.prNumber} on GitHub`}>#{c.prNumber}</button>
          {card.shown && <PrCard change={c} />}
        </span>
      )}
      <span className="prrepo">{c.repo.split("/")[1]}</span>
      <div className="prbranchwrap" onClick={(e) => e.stopPropagation()}>
        <button className="prbranch" aria-expanded={open === "branch"} aria-haspopup="menu" onClick={() => setOpen(open === "branch" ? null : "branch")} title={c.branch}>{label}</button>
        {open === "branch" && (
          <div className="prmenu" role="menu">
            <button role="menuitem" onClick={() => { setOpen(null); void navigator.clipboard.writeText(c.branch).then(() => toast("Branch name copied"), () => toast("Couldn't copy the branch name")); }}>Copy branch name</button>
            <button role="menuitem" onClick={() => { setOpen(null); openHref(branchUrl); }}>Open branch on GitHub</button>
          </div>
        )}
      </div>
      {c.prNumber && c.syncError && <span className="prstale" title={c.syncError}>out of date</span>}
      <span className="add">+{c.add}</span><span className="del">−{c.del}</span>
      {c.prNumber && href && !!c.comments?.length && (
        <button className="cichip comments" onClick={() => openHref(href)} title={`${c.comments.length} unresolved review comment${c.comments.length === 1 ? "" : "s"} · open on GitHub`}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>{c.comments.length}
        </button>
      )}
      {!c.prNumber || !href ? <button className="cichip create" disabled={creating} onClick={create}>{creating ? "Creating…" : "Create PR"}</button>
      : (
        <div className="ci" onClick={(e) => e.stopPropagation()}>
          <button className={`cichip ${c.checks?.state ?? "unknown"}`} aria-expanded={open === "ci"} aria-haspopup="dialog" onClick={toggleCi} title={`CI ${ciWord(c.checks)}${c.syncError ? ` · couldn't refresh: ${c.syncError}` : ""}`}>
            <CiDot checks={c.checks} />CI<span className="chev" aria-hidden="true">▾</span>
          </button>
          {open === "ci" && <CiPopover change={c} href={href} error={ciError} askHandle={askHandle} onAsk={(t) => { setOpen(null); onAsk(t); }} onAuto={onAuto} {...(handleOf ? { handleOf } : {})} />}
        </div>
      )}
    </div>
  );
}

export function CiPopover({ change: c, href, error = null, askHandle, onAsk, onAuto, handleOf }: { change: Change; href: string; error?: string | null; onAuto?: (kind: Auto, on: boolean) => void } & PrProps) {
  const k = c.checks;
  const counts = k ? ([["failed", "Failed", k.failed], ["pending", "Running", k.pending], ["passed", "Passed", k.passed], ["skipped", "Skipped", k.skipped]] as const).filter(([, , n]) => n > 0) : [];
  const worth = k?.items.filter((i) => i.state === "failed" || i.state === "pending").slice(0, 8) ?? [];
  const comments = c.comments ?? [];
  return (
    <div className="cipop" role="dialog" aria-label={`CI for #${c.prNumber}`}>
      <div className="cih"><span>CI monitoring</span><button className="cilink" onClick={() => openHref(`${href}/checks`)} title="Open checks on GitHub">↗</button></div>
      {!k && <div className="cinote">{error || c.syncError ? `Beam can't read this PR's checks right now${c.syncError ? ` (${c.syncError})` : ""}. They're on GitHub.` : "Checking GitHub…"}</div>}
      {k && c.syncError && <div className="cinote stale">Couldn't refresh ({c.syncError}). This is CI as of {ago(k.checkedAt, Date.now())}.</div>}
      {k?.state === "none" && <div className="cinote">No checks reported on the latest commit.</div>}
      {k?.state === "failing" && !k.failed && <div className="cinote">GitHub reports a failing check among more than Beam lists here.</div>}
      {counts.map(([state, label, n]) => <div key={state} className={`cicount ${state}`}><span className={`ci-mark ${state}`} aria-hidden="true" /><span>{label}</span><span className="n">{n}</span></div>)}
      {worth.length > 0 && <div className="ciitems">{worth.map((i, n) => (
        <button key={`${i.name}-${n}`} className={`ciitem ${i.state}`} disabled={!i.url} onClick={() => i.url && openHref(i.url)} title={i.url ? "Open the log" : undefined}>
          <span className={`ci-mark ${i.state}`} aria-hidden="true" /><span className="nm">{i.name}</span>
        </button>
      ))}</div>}
      {comments.length > 0 && <div className="ciitems" aria-label="Unresolved review comments">
        <div className="cisub">Review comments<span className="n">{comments.length}</span></div>
        {comments.slice(0, 5).map((m) => (
          <button key={m.id} className="ciitem comment" disabled={!m.url} onClick={() => m.url && openHref(m.url)} title={m.body}>
            <span className="nm">{m.path ? `${m.path.split("/").pop()}${m.line ? `:${m.line}` : ""}` : "Changes requested"}</span>
            {m.author && <span className="by">{m.author}</span>}
          </button>
        ))}
      </div>}
      {onAuto && c.prNumber && <div className="ciauto">
        <AutoRow label="Auto-fix CI & address comments" on={!!c.autoFix} onChange={(on) => onAuto("fix", on)}
          detail={c.autoFix && (c.autoFix.note ?? `${handleOf?.(c.autoFix.agentId) ? `@${handleOf(c.autoFix.agentId)} fixes` : "Fixes"} as ${c.autoFix.by}`)} warn={!!c.autoFix?.note}
          title="When checks fail or reviewers leave comments, send the thread's agent to fix them, as you" />
        <AutoRow label="Auto-merge when ready" on={!!c.autoMerge} onChange={(on) => onAuto("merge", on)}
          detail={c.autoMerge && (c.autoMerge.note ?? `Merges as ${c.autoMerge.by}`)} warn={!!c.autoMerge?.note?.startsWith("GitHub didn't") || !!c.autoMerge?.note?.startsWith("Beam has no")}
          title="Merge on GitHub, as you, once checks pass, reviews allow it and no comments are open" />
        <AutoRow label="Settle thread on merge or close" on={!!c.autoSettle} onChange={(on) => onAuto("settle", on)}
          title="When this PR merges or closes and no other PR in the thread is open, settle the thread. A new message reopens it." />
      </div>}
      <div className="cift">
        {(k?.state === "failing" || comments.length > 0) && askHandle && <button className="ciask" onClick={() => onAsk(fixPrompt(askHandle, c))}>Ask @{askHandle} to fix</button>}
        <button onClick={() => openHref(href)}>View PR</button>
        {k && <span className="ciago">updated {ago(k.checkedAt, Date.now())}</span>}
      </div>
    </div>
  );
}

function AutoRow({ label, on, onChange, detail, warn = false, title }: { label: string; on: boolean; onChange: (on: boolean) => void; detail?: string | undefined | false; warn?: boolean; title: string }) {
  return (
    <label className="ciautorow" title={title}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="lb">{label}{detail && <small className={warn ? "warn" : undefined}>{detail}</small>}</span>
    </label>
  );
}
