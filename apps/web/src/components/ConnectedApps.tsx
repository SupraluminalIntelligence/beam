import { useMutation, useQuery } from "convex/react";
import { useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";
import { SCOPES } from "@beam/contracts/worlds";

/** What each scope lets an app do, in the contract's own words, shown before anyone approves it. */
const scopeText = (s: string) => (SCOPES as Record<string, string>)[s] ?? `Unknown permission "${s}"`;
const plain = (e: unknown) => { const data = (e as { data?: unknown }).data; return typeof data === "string" ? data : String((e as Error).message ?? e).replace(/^.*Uncaught Error: /s, "").split("\n")[0] ?? ""; };

/**
 * Browser side of `beam login`: an app built on Beam (a CLI, a game, a dashboard) is waiting on a code.
 * Approving lets it act as you within the scopes listed here, until you revoke it in Settings.
 */
export function ApproveLayer({ code, onDone }: { code: string; onDone: () => void }) {
  const live = useQuery(api.layers.pending, { userCode: code });
  // The app collects its token and the code disappears the moment it is approved. Keep describing what was approved.
  const seen = useRef<typeof live>(undefined);
  if (live) seen.current = live;
  const me = useQuery(api.users.me);
  const approve = useMutation(api.layers.approve);
  const deny = useMutation(api.layers.deny);
  const [state, setState] = useState<"idle" | "approved" | "denied">("idle");
  const pending = state === "idle" ? live : seen.current ?? live;
  const decide = async (yes: boolean) => {
    try { if (yes) await approve({ userCode: code }); else await deny({ userCode: code }); setState(yes ? "approved" : "denied"); }
    catch (e) { toast(plain(e)); }
  };
  return (
    <div className="signin">
      <div className="box">
        <h1 style={{ fontSize: 28 }}>Connect an app to Beam?</h1>
        {pending === undefined ? <div className="k">…</div>
          : state !== "idle" ? null
          : !pending || pending.status === "denied" ? <div style={{ color: "var(--ink-2)" }}>No app is waiting with code <span className="mono">{code}</span>. It may have expired; run <span className="mono">beam login</span> again.</div>
          : <>
            <div style={{ color: "var(--ink-2)" }}><b>{pending.name}</b>{pending.hostname ? <> on {pending.hostname}</> : null} is waiting with code <span className="mono">{code}</span>. Approving lets it, as <b>{me?.name}</b>:</div>
            <ul style={{ margin: 0, paddingLeft: 18, textAlign: "left", color: "var(--ink-2)" }}>{pending.scopes.map((s) => <li key={s}>{scopeText(s)}</li>)}</ul>
            <div className="k">It can never change settings, agents or workspaces, invite people, or approve machines. Revoke it any time in Settings → Connected apps.</div>
          </>}
        {state === "approved" ? <div style={{ color: "var(--ok)" }}>Connected. You can go back to {pending?.name ?? "the app"}.</div>
          : state === "denied" ? <div style={{ color: "var(--ink-2)" }}>Declined. Nothing was shared.</div>
          : pending && pending.status === "pending" && <>
            <button className="btn" onClick={() => void decide(true)}>Approve</button>
            <button className="btn ghost" onClick={() => void decide(false)}>Decline</button>
          </>}
        <button className="btn ghost" onClick={onDone}>{state === "idle" ? "Not now" : "Back to Beam"}</button>
      </div>
    </div>
  );
}

/** Settings → Connected apps: every app holding a token for you, and the switch to cut it off. */
export function ConnectedApps() {
  const apps = useQuery(api.layers.mine);
  const revoke = useMutation(api.layers.revoke);
  const [code, setCode] = useState("");
  const ready = code.replace(/[^A-Z0-9]/gi, "").length === 8;
  return <>
    <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Apps that can use Beam as you</div>
    {apps === undefined ? <div className="row"><span className="hint">Loading…</span></div>
      : apps.length === 0 ? <div className="row connection-note"><span className="hint">None yet. Interfaces built on Beam (games, dashboards, the <span className="mono">beam</span> CLI) connect with <span className="mono">beam login</span>.</span></div>
      : apps.map((a) => (
        <div className="row" key={a.id}>
          <span>{a.name}<span className="hint"> · {a.hostname || "unknown machine"} · since {new Date(a.createdAt).toLocaleDateString()}</span></span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="hint">{a.revokedAt ? "revoked" : a.scopes.join(", ")}</span>
            {!a.revokedAt && <button className="btn ghost" onClick={() => void revoke({ id: a.id as Id<"layerTokens"> }).then(() => toast(`${a.name} can no longer use Beam`), (e) => toast(plain(e)))}>Revoke</button>}
          </span>
        </div>
      ))}
    <div className="row">
      <span>Connect an app</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" style={{ width: 130, fontFamily: '"IBM Plex Mono", monospace' }} />
        <button className="btn" disabled={!ready} onClick={() => { location.search = `?connect=${encodeURIComponent(code.trim())}`; }}>Review</button>
        <span className="hint">the code from <span className="mono">beam login</span></span>
      </span>
    </div>
  </>;
}
