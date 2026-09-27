import type { SetupCheck } from "@beam/contracts";

const mark = { ok: "✓", warn: "!", fail: "✕", unknown: "?", info: "" } as const;
export const flagged = (checks: SetupCheck[]) => checks.filter(c => c.status === "fail" || c.status === "warn");

/** One row per check; checks that need attention also explain themselves underneath. */
export function SetupChecks({ checks }: { checks: SetupCheck[] }) {
  return <>
    {checks.map(c => <div className={`sim-value sim-check ${c.status}`} key={c.id} title={c.detail}><span>{c.label}</span><span>{mark[c.status]&&<b aria-label={c.status}>{mark[c.status]}</b>}{c.value}</span></div>)}
    {checks.filter(c => c.status !== "ok" && c.status !== "info").map(c => <p key={c.id} className={`sim-check-note ${c.status}`}>{c.detail}</p>)}
  </>;
}

export function checkSummary(checks: SetupCheck[]) {
  const count = (s: SetupCheck["status"]) => checks.filter(c => c.status === s).length;
  return [count("fail") && `${count("fail")} fail`, count("warn") && `${count("warn")} to review`, count("unknown") && `${count("unknown")} need fluid data`].filter(Boolean).join(" · ") || "all hold";
}
