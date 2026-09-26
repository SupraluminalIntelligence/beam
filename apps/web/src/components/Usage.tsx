import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { currentWindows, tightestWindow, UsageLimits, type UsageWindow } from "@beam/contracts";
import { connectionStatuses } from "../../../../packages/contracts/src/connections";
import { AgentAvatar } from "./Avatar";
import { toast } from "./Toast";

const NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const SHORT: Record<string, string> = { claude: "Claude", codex: "Codex", omp: "omp" };

type Runner = { id: unknown; name: string; online: boolean; harnesses: unknown };
type Account = { runner: Runner; harness: string; connectionId: string; connectionName: string; isDefault: boolean; auth: string; plan: string | null; email: string | null; usage: UsageLimits | undefined };

/** Every signed-in account on my machines, with whatever usage its last probe or run reported. */
function accounts(runners: Runner[] | undefined): Account[] {
  return (runners ?? []).flatMap((runner) => connectionStatuses(runner.harnesses).filter((s) => s.auth === "authenticated").map((s) => ({
    runner, harness: s.harness, connectionId: s.connectionId, connectionName: s.connectionName, isDefault: s.isDefault, auth: s.auth,
    plan: s.plan ?? null, email: s.email ?? null, usage: UsageLimits.safeParse((s as { usage?: unknown }).usage).data,
  })));
}

/** Re-renders every minute so "resets in" and hidden expired windows stay honest. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t); }, []);
  return now;
}

export const level = (percent: number) => (percent >= 90 ? "bad" : percent >= 75 ? "warn" : "ok");

function until(t: number, now: number) {
  const mins = Math.max(1, Math.round((t - now) / 60_000));
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ""}`.trim();
  return new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
const ago = (t: number, now: number) => { const m = Math.round((now - t) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

/** Settings › Usage & limits. Plan windows per account on each of my machines. */
export function UsagePage() {
  const runners = useQuery(api.runners.mine);
  const requestProbe = useMutation(api.runners.requestProbe);
  const [probing, setProbing] = useState(false);
  const now = useNow();
  const list = accounts(runners);
  const refresh = async () => {
    setProbing(true);
    try { await Promise.all((runners ?? []).filter((r) => r.online).map((r) => requestProbe({ runnerId: r.id as Id<"runners"> }))); }
    catch (e) { toast((e as Error).message); }
    window.setTimeout(() => setProbing(false), 4000);
  };
  if (runners === undefined) return <div className="row"><span className="hint">Loading…</span></div>;
  return <>
    <div className="row usage-intro"><span className="hint">How much of each plan window your accounts have used. Read from the CLIs on your machines when they are checked and while agents run. Teammates who use a shared account spend from these too.</span>
      <button className="btn ghost" disabled={probing || !runners.some((r) => r.online)} onClick={() => void refresh()}>{probing ? "Checking…" : "Check now"}</button></div>
    {!list.length && <div className="row connection-note"><span className="hint">No signed-in accounts yet. Sign in to Claude Code or Codex under Machines.</span></div>}
    {list.map((a) => <div key={`${String(a.runner.id)}:${a.harness}:${a.connectionId}`} className="hlist usage-account">
      <div className="hrow head">
        <AgentAvatar harness={a.harness} />
        <span className="hwho"><span className="nm">{NAME[a.harness] ?? a.harness}{a.connectionId !== "default" ? ` · ${a.connectionName}` : ""}</span>
          <span className="k">{[a.runner.name, a.plan, a.email].filter(Boolean).join(" · ")}</span></span>
        <span className="sp" />
        {a.usage && <span className="hseen">checked {ago(a.usage.checkedAt, now)}</span>}
      </div>
      <UsageWindows usage={a.usage} harness={a.harness} now={now} />
    </div>)}
  </>;
}

function UsageWindows({ usage, harness, now }: { usage: UsageLimits | undefined; harness: string; now: number }) {
  const windows = currentWindows(usage, now);
  if (windows.length) return <>{windows.map((w) => <UsageBar key={w.id} w={w} now={now} />)}</>;
  const note = !usage ? (harness === "omp" ? "omp does not report plan limits." : "Not reported yet. Update the runner, then check again.")
    : usage.unavailable === "unsupported" ? "No plan limits: this account uses an API key or an outside provider."
    : usage.unavailable === "failed" ? "Could not read usage on the last check."
    : "No usage yet in the current windows.";
  return <div className="hrow"><span className="hint">{note}</span></div>;
}

function UsageBar({ w, now }: { w: UsageWindow; now: number }) {
  const pct = Math.round(w.usedPercent);
  return <div className="hrow usage-row">
    <span className="usage-label">{w.label}</span>
    <span className={`usage-bar ${level(w.usedPercent)}`} role="meter" aria-label={`${w.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${Math.max(pct, 1)}%` }} /></span>
    <span className="usage-pct">{pct}%</span>
    <span className="k usage-reset">{w.resetsAt ? `resets ${until(w.resetsAt, now)}` : ""}</span>
  </div>;
}

/**
 * One line for the account menu: the tightest window per harness across my accounts,
 * e.g. "Claude 62% · Codex 18%". Null when nothing has been reported.
 */
export function useUsageSummary(): { text: string; level: "ok" | "warn" | "bad" } | null {
  const runners = useQuery(api.runners.mine);
  const now = useNow();
  const top = new Map<string, UsageWindow>();
  for (const a of accounts(runners)) {
    const w = tightestWindow(a.usage, now);
    if (w && (!top.has(a.harness) || w.usedPercent > top.get(a.harness)!.usedPercent)) top.set(a.harness, w);
  }
  if (!top.size) return null;
  const max = Math.max(...[...top.values()].map((w) => w.usedPercent));
  return { text: [...top].map(([h, w]) => `${SHORT[h] ?? h} ${Math.round(w.usedPercent)}%`).join(" · "), level: level(max) };
}
