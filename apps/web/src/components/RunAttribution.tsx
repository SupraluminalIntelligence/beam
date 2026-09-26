import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

/** Keep the message header compact; account details belong to the hover card. */
export function RunAttribution({ run, nameOf }: { run: Doc<"runs">; nameOf: (login: string) => string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const execution = run.execution;
  const machineName = useQuery(api.runners.nameForRun, position ? { runId: run._id } : "skip");
  const cancelClose = () => { if (timer.current) clearTimeout(timer.current); };
  const close = () => { cancelClose(); setPosition(null); };
  const hide = () => { cancelClose(); timer.current = setTimeout(() => setPosition(null), 120); };
  const show = () => {
    cancelClose();
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 210 > window.innerHeight;
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), top: above ? rect.top - 8 : rect.bottom + 8, above });
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!position) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [position]);
  if (!execution) return null;
  return <>
    <button ref={trigger} className="run-attribution" aria-describedby={position ? id : undefined} aria-label={`${execution.modelName ?? execution.model} · ${execution.effort}. Show account details`}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={close} onClick={show}>
      {execution.modelName ?? execution.model} · {execution.effort}
    </button>
    {position && createPortal(<div id={id} role="tooltip" className="run-account-card" style={{ left: position.left, top: position.top, transform: position.above ? "translateY(-100%)" : undefined }}
      onMouseEnter={cancelClose} onMouseLeave={hide}>
      <div className="run-account-heading">Run details</div>
      <dl>
        <dt>Requested by</dt><dd>{nameOf(run.dispatchedBy)}</dd>
        <dt>Account</dt><dd>{nameOf(execution.accountOwner)}{execution.accountEmail && <small>{execution.accountEmail}</small>}</dd>
        <dt>Connection</dt><dd>{execution.connectionName ?? "Default account"}</dd>
        <dt>Machine</dt><dd title={machineName && execution.machineName && machineName !== execution.machineName ? `Named ${execution.machineName} when this run started` : undefined}>{machineName ?? execution.machineName ?? "Not recorded"}</dd>
        <dt>Subscription</dt><dd>{execution.accountPlan ?? "Not reported"}</dd>
      </dl>
    </div>, document.body)}
  </>;
}
