import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { useLocalRunner } from "../lib/localRunner";
import { AgentAvatar } from "./Avatar";
import { DefaultAccounts, LocalAccounts, useLocalProfiles } from "./Connections";
import { toast } from "./Toast";

type Status = { connectionId?: string; connectionName?: string; harness: string; installed: boolean; version: string | null; auth: string; plan: string | null; email: string | null; message: string | null; probedAt: number };
type Runner = NonNullable<ReturnType<typeof useQuery<typeof api.runners.mine>>>[number];
const NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const LOGIN: Record<string, string> = { claude: "claude auth login", codex: "codex login", omp: "omp" };
const INSTALL: Record<string, string> = { claude: "npm i -g @anthropic-ai/claude-code", codex: "npm i -g @openai/codex", omp: "curl -fsSL https://omp.sh/install | sh" };

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

/** Settings → Machines. One card per runner: what it found, its name, its local accounts, and sharing. Beam never holds a credential. */
export function Machines({ pairCode }: { pairCode?: string | null }) {
  const runners = useQuery(api.runners.mine);
  const requestProbe = useMutation(api.runners.requestProbe);
  const localId = useLocalRunner();
  const [profiles, setProfiles] = useLocalProfiles();
  const b = bridge();
  useEffect(() => {
    // re-probe when the window regains focus, at most once a minute
    let last = 0;
    const onFocus = () => { const now = Date.now(); if (now - last < 60_000) return; last = now; for (const r of runners ?? []) if (r.online) void requestProbe({ runnerId: r.id as Id<"runners"> }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runners, requestProbe]);
  const sorted = [...(runners ?? [])].sort((x, y) => Number(y.id === localId) - Number(x.id === localId) || Number(y.online) - Number(x.online));
  return <>
    <DefaultAccounts runners={runners ?? []} />
    <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Your machines</div>
    {runners === undefined ? <div className="row"><span className="hint">Loading…</span></div>
      : runners.length === 0 ? <div className="row connection-note"><span className="hint">No machine yet. {b ? "The app is starting one; it connects on its own in a few seconds." : "Run `beam-runner login` on a machine, or open the desktop app."}</span></div>
      : sorted.map((r) => <MachineCard key={String(r.id)} r={r} local={r.id === localId}>
        {r.id === localId && profiles && <LocalAccounts profiles={profiles} setProfiles={setProfiles} onChange={async () => { await requestProbe({ runnerId: r.id as Id<"runners"> }); }} />}
      </MachineCard>)}
    <ConnectMachine initial={pairCode ?? null} />
  </>;
}

function MachineCard({ r, local, children }: { r: Runner; local: boolean; children?: ReactNode }) {
  const requestProbe = useMutation(api.runners.requestProbe);
  const setSharing = useMutation(api.runners.setSharing);
  const [probing, setProbing] = useState(false);
  const b = bridge();
  const statuses = (r.harnesses as Status[] | null) ?? [];
  // A missing CLI already shows its install command; only repeat messages that add something.
  const notes = statuses.filter((s) => s.installed && s.message && s.auth !== "authenticated");
  return (
    <div className="hlist">
      <div className="hrow head">
        <span className={`sq ${r.online ? "ok" : "idle"}`} />
        <span className="hwho"><MachineName r={r} /><span className="k">{local ? "this machine · " : ""}{r.hostname}{r.launchedByApp ? "" : " · headless"}</span></span>
        <span className="sp" />
        <span className={`hseen${r.online ? " on" : ""}`}>{r.online ? "online" : `offline · last seen ${ago(r.lastSeen)}`}</span>
        <button className={`nav-icon hrefresh${probing ? " busy" : ""}`} title={r.online ? "Check harnesses again" : "Machine is offline"} aria-label={probing ? "Checking harnesses" : "Check harnesses again"} disabled={!r.online || probing} onClick={async () => { setProbing(true); await requestProbe({ runnerId: r.id as Id<"runners"> }); setTimeout(() => setProbing(false), 4000); toast("Re-probing"); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3h3M4 13a8 8 0 0 0 14.6 4.5M20 20v-3h-3" /></svg></button>
      </div>
      {statuses.map((s) => {
        const profile = s.connectionId && s.connectionId !== "default";
        return <div key={`${s.harness}:${s.connectionId ?? "default"}`} className="hrow">
          <AgentAvatar harness={s.harness} />
          <span className="nm">{NAME[s.harness] ?? s.harness}{profile && s.connectionName ? ` · ${s.connectionName}` : ""}</span>
          <span className="k ver">{s.installed ? `v${s.version ?? "?"}` : ""}</span>
          <span className={`st ${s.installed ? s.auth : "missing"}`}>{!s.installed ? "not installed" : s.auth === "authenticated" ? "signed in" : s.auth === "unauthenticated" ? "not signed in" : "unverified"}</span>
          <span className="k">{[s.plan, s.email].filter(Boolean).join(" · ")}</span>
          <span className="sp" />
          {s.installed && s.auth !== "authenticated" && (profile
            ? local && b?.signInConnection && <button className="cmd" title={`Sign in to ${s.connectionName ?? "this profile"} in Terminal`} onClick={() => void b.signInConnection!(s.harness as "codex" | "claude", s.connectionId!).catch((e) => toast(e.message))}><CmdIcon kind="sign in" />Sign in</button>
            : <Cmd cmd={LOGIN[s.harness] ?? ""} kind="sign in" />)}
          {!s.installed && <Cmd cmd={INSTALL[s.harness] ?? ""} kind="install" />}
        </div>;
      })}
      {notes.length > 0 && <div className="hnote">{notes.map((s) => <div key={`${s.harness}:${s.connectionId ?? "default"}`}>{NAME[s.harness] ?? s.harness}: {s.message}</div>)}</div>}
      {children}
      <label className="hrow hopt"><input type="checkbox" checked={r.allowSharedRuns} onChange={(e) => void setSharing({ runnerId: r.id as Id<"runners">, allow: e.target.checked }).catch((e) => toast(e.message))} /> Let teammates choose this machine’s accounts</label>
    </div>
  );
}

/** The machine's name, edited in place. Saves on blur or Enter; Escape puts it back. */
function MachineName({ r }: { r: Runner }) {
  const rename = useMutation(api.runners.rename);
  return <input type="text" className="mname" aria-label={`Name for ${r.name}`} title="Rename this machine" key={r.name} defaultValue={r.name} maxLength={80} size={Math.max(8, Math.min(r.name.length + 1, 32))}
    onBlur={(e) => { const next = e.target.value.trim(); if (!next) e.target.value = r.name; else if (next !== r.name) void rename({ runnerId: r.id as Id<"runners">, name: next }).catch((err) => { e.target.value = r.name; toast(err.message); }); }}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.value = r.name; e.currentTarget.blur(); } }} />;
}

type CmdKind = "sign in" | "install" | "copy";
const CMD_ICON: Record<CmdKind, ReactNode> = {
  "sign in": <path d="M15 3h4a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3" />,
  install: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  copy: <><rect x="9" y="9" width="12" height="12" rx="1" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
};
function CmdIcon({ kind }: { kind: CmdKind }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{CMD_ICON[kind]}</svg>;
}

/** Runs the command in Terminal in the desktop app; copies it in a browser. The command itself is in the tooltip. */
function Cmd({ cmd, kind }: { cmd: string; kind: "sign in" | "install" }) {
  const b = bridge();
  const label = kind === "install" ? "Install" : "Sign in";
  return (
    <button className="cmd" title={b ? `Runs in Terminal: ${cmd}` : `Copy: ${cmd}`} onClick={async () => {
      if (b) { await b.openTerminalWith(cmd); toast(`Opened Terminal with: ${cmd}`); }
      else { await navigator.clipboard.writeText(cmd).catch(() => {}); toast(`Copied: ${cmd}`); }
    }}><CmdIcon kind={b ? kind : "copy"} />{b ? label : `Copy ${label.toLowerCase()}`}</button>
  );
}

/** Collapsed until needed: a pairing code from the app or a link opens it. */
function ConnectMachine({ initial }: { initial: string | null }) {
  const [open, setOpen] = useState(!!initial);
  useEffect(() => { if (initial) setOpen(true); }, [initial]);
  if (!open) return <div className="row connection-note"><span><button className="btn ghost" onClick={() => setOpen(true)}>Connect another machine</button></span></div>;
  return <ApproveRunner initial={initial} />;
}

/** Approve a runner's device code. Auto-fills from the app-launched runner, or type one from `beam-runner login`. */
export function ApproveRunner({ initial }: { initial?: string | null }) {
  const approve = useMutation(api.runnerAuth.approve);
  const [code, setCode] = useState(initial ?? "");
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (initial) setCode(initial); }, [initial]);
  const pending = useQuery(api.runnerAuth.pending, code.replace(/[^A-Z0-9-]/gi, "").length >= 9 ? { userCode: code.toUpperCase() } : "skip");
  const go = async () => {
    try { const r = await approve({ userCode: code }); setDone(r.name); toast(r.already ? `${r.name} was already approved` : `Approved ${r.name}`); }
    catch (e) { toast(String((e as Error).message).replace(/^.*Uncaught Error: /, "")); }
  };
  return (
    <div className="row">
      <span>Connect a machine</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" style={{ width: 130, fontFamily: '"IBM Plex Mono", monospace' }} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        <button className="btn" disabled={!pending || pending.status === "approved"} onClick={() => void go()}>Approve</button>
        <span className="hint">{done ? `${done} approved` : pending ? `${pending.name} on ${pending.hostname} is waiting` : code ? "no runner is waiting with that code" : "the code from `beam-runner login` on that machine"}</span>
      </span>
    </div>
  );
}
