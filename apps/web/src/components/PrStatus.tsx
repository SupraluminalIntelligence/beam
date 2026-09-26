import { useMutation } from "convex/react";
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

function PrRow({ change: c, askHandle, onAsk }: { change: Change; askHandle: string | null; onAsk: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const refresh = useMutation(api.changes.refresh);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("click", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const toggle = () => {
    if (!open) void refresh({ changeId: c._id }).catch((e) => toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")));
    setOpen(!open);
  };
  const href = c.prUrl;
  return (
    <div className="prrow">
      <span className="prico" aria-hidden="true">⎇</span>
      {c.prNumber && href ? <button className="prnum" onClick={() => openHref(href)} title={`Open ${c.title} on GitHub`}>#{c.prNumber}</button> : <span className="k">no PR</span>}
      <span className="prrepo">{c.repo.split("/")[1]}</span>
      <span className="prbranch" title={c.title}>{c.branch}</span>
      {c.draft && <span className="k">draft</span>}
      <span className="add">+{c.add}</span><span className="del">−{c.del}</span>
      {c.prNumber && href && (
        <div className="ci" onClick={(e) => e.stopPropagation()}>
          <button className={`cichip ${c.checks?.state ?? "unknown"}`} aria-expanded={open} aria-haspopup="dialog" onClick={toggle} title={`CI ${ciWord(c.checks)}`}>
            <CiDot checks={c.checks} />CI<span className="chev" aria-hidden="true">▾</span>
          </button>
          {open && <CiPopover change={c} href={href} askHandle={askHandle} onAsk={(t) => { setOpen(false); onAsk(t); }} />}
        </div>
      )}
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
