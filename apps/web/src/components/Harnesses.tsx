import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { AgentAvatar } from "./Avatar";
import { toast } from "./Toast";

type Status = { harness: string; installed: boolean; version: string | null; auth: string; plan: string | null; email: string | null; message: string | null; probedAt: number };
const NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", omp: "omp" };
const LOGIN: Record<string, string> = { claude: "claude auth login", codex: "codex login", omp: "omp" };
const INSTALL: Record<string, string> = { claude: "npm i -g @anthropic-ai/claude-code", codex: "npm i -g @openai/codex", omp: "curl -fsSL https://omp.sh/install | sh" };

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

/** Settings → Connected harnesses. What each of my runners found on its machine. Beam never holds a credential. */
export function Harnesses() {
  const runners = useQuery(api.runners.mine);
  const requestProbe = useMutation(api.runners.requestProbe);
  const [busy, setBusy] = useState<string | null>(null);
  const b = bridge();
  useEffect(() => {
    // re-probe when the window regains focus, at most once a minute
    let last = 0;
    const onFocus = () => { const now = Date.now(); if (now - last < 60_000) return; last = now; for (const r of runners ?? []) if (r.online) void requestProbe({ runnerId: r.id as Id<"runners"> }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runners, requestProbe]);
  if (runners === undefined) return <div className="row"><span>Connected harnesses</span><span className="hint">…</span></div>;
  if (runners.length === 0) return <div className="row"><span>Connected harnesses</span><span className="hint">No runner yet. {b ? "The app is starting one; approve it below when its code appears." : "Run `beam-runner login` on a machine, or open the desktop app."}</span></div>;
  return (
    <>
      {runners.map((r) => (
        <div key={String(r.id)} className="hlist">
          <div className="hrow head">
            <span className={`sq ${r.online ? "ok" : "idle"}`} />
            <span className="nm">{r.name}</span>
            <span className="k">{r.hostname} · {r.online ? "online" : `last seen ${ago(r.lastSeen)}`}{r.launchedByApp ? " · via app" : " · headless"}</span>
            <span className="sp" />
            <button className="k" disabled={!r.online || busy === String(r.id)} onClick={async () => { setBusy(String(r.id)); await requestProbe({ runnerId: r.id as Id<"runners"> }); setTimeout(() => setBusy(null), 4000); toast("Re-probing"); }}>{busy === String(r.id) ? "probing…" : "refresh"}</button>
          </div>
          {((r.harnesses as Status[] | null) ?? []).map((s) => (
            <div key={s.harness} className="hrow">
              <AgentAvatar harness={s.harness} />
              <span className="nm">{NAME[s.harness] ?? s.harness}</span>
              <span className="k">{s.installed ? `v${s.version ?? "?"}` : "not installed"}</span>
              <span className={`st ${s.auth}`}>{s.auth === "authenticated" ? "signed in" : s.auth === "unauthenticated" ? "not signed in" : s.installed ? "unverified" : ""}</span>
              <span className="k">{[s.plan, s.email].filter(Boolean).join(" · ")}</span>
              <span className="sp" />
              {s.installed && s.auth !== "authenticated" && <Cmd cmd={LOGIN[s.harness] ?? ""} label="sign in" />}
              {!s.installed && <Cmd cmd={INSTALL[s.harness] ?? ""} label="install" />}
            </div>
          ))}
          {((r.harnesses as Status[] | null) ?? []).some((s) => s.message && s.auth !== "authenticated") && (
            <div className="hnote">{((r.harnesses as Status[]) ?? []).filter((s) => s.message && s.auth !== "authenticated").map((s) => <div key={s.harness}>{NAME[s.harness]}: {s.message}</div>)}</div>
          )}
        </div>
      ))}
    </>
  );
}

function Cmd({ cmd, label }: { cmd: string; label: string }) {
  const b = bridge();
  return (
    <button className="k cmd" title={cmd} onClick={async () => {
      if (b) { await b.openTerminalWith(cmd); toast(`Opened Terminal with: ${cmd}`); }
      else { await navigator.clipboard.writeText(cmd).catch(() => {}); toast(`Copied: ${cmd}`); }
    }}>{b ? `${label} in Terminal` : `copy ${label} command`}</button>
  );
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
      <span>Approve a runner</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" style={{ width: 130, fontFamily: '"IBM Plex Mono", monospace' }} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        <button className="btn" disabled={!pending || pending.status === "approved"} onClick={() => void go()}>Approve</button>
        <span className="hint">{done ? `${done} approved` : pending ? `${pending.name} on ${pending.hostname} is waiting` : code ? "no runner is waiting with that code" : "from `beam-runner login`, or auto-filled by the app"}</span>
      </span>
    </div>
  );
}
