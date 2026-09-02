import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { bridge } from "./bridge";
import { Shell } from "./components/Shell";
import { Toast } from "./components/Toast";

export function App() {
  return (
    <>
      <AuthLoading><div className="signin"><div className="k">…</div></div></AuthLoading>
      <Unauthenticated><SignIn /></Unauthenticated>
      <Authenticated><Gate /></Authenticated>
      <Toast />
    </>
  );
}

const siteUrl = () => (import.meta.env["VITE_CONVEX_URL"] as string).replace(".convex.cloud", ".convex.site");

function SignIn() {
  const { signIn } = useAuthActions();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<{ userCode: string; url: string } | null>(null);
  const b = bridge();
  const approveParam = new URLSearchParams(location.search).get("approve");

  /** Desktop: never sign in inside the Electron window. Start a device code, open the system browser, poll the "device" provider. */
  async function desktopSignIn() {
    setBusy(true);
    const r = await fetch(`${siteUrl()}/runner/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "desktop", name: "Beam desktop", hostname: navigator.platform }) });
    const d = (await r.json()) as { deviceCode: string; userCode: string; verifyUrl: string };
    setWaiting({ userCode: d.userCode, url: d.verifyUrl });
    await b!.openExternal(d.verifyUrl);
    const started = Date.now();
    while (Date.now() - started < 15 * 60_000) {
      await new Promise((res) => setTimeout(res, 2000));
      try { await signIn("device", { deviceCode: d.deviceCode }); return; } catch { /* not approved yet */ }
    }
    setWaiting(null); setBusy(false);
  }

  return (
    <div className="signin">
      <div className="box">
        <div className="k" style={{ letterSpacing: ".12em", textTransform: "uppercase", textAlign: "left" }}>Supraluminal Intelligence</div>
        <h1>Beam</h1>
        <div style={{ color: "var(--ink-2)" }}>Argue it out. Then beam it.</div>
        {waiting ? (
          <>
            <div style={{ color: "var(--ink-2)" }}>Finish signing in in your browser. This window will follow along.</div>
            <div className="mono" style={{ fontSize: 22, textAlign: "center", letterSpacing: ".08em" }}>{waiting.userCode}</div>
            <div className="k">If the browser did not open, go to {waiting.url}</div>
            <button className="btn ghost" onClick={() => { setWaiting(null); setBusy(false); }}>Cancel</button>
          </>
        ) : b ? (
          <button className="btn" disabled={busy} onClick={() => void desktopSignIn()}>Continue with GitHub in your browser</button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => { setBusy(true); void signIn("github", approveParam ? { redirectTo: `/?approve=${approveParam}` } : {}); }}>Continue with GitHub</button>
        )}
        {!waiting && <button className="btn ghost" disabled={busy} onClick={() => { setBusy(true); void signIn("anonymous"); }}>Continue as a guest</button>}
        {!waiting && <div className="k">{b ? "Your browser already has your GitHub session. The app never sees the password." : "Guests can do everything except own a runner."}</div>}
      </div>
    </div>
  );
}

/** Browser side of desktop sign-in: a signed-in person approves the code the app is waiting on. */
function ApproveDesktop({ code, onDone }: { code: string; onDone: () => void }) {
  const pending = useQuery(api.runnerAuth.pending, { userCode: code });
  const approve = useMutation(api.runnerAuth.approve);
  const me = useQuery(api.users.me);
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  return (
    <div className="signin">
      <div className="box">
        <h1 style={{ fontSize: 28 }}>Sign in Beam on your Mac?</h1>
        {pending ? <div style={{ color: "var(--ink-2)" }}>{pending.name} on {pending.hostname} is waiting with code <span className="mono">{code}</span>. Approving signs it in as <b>{me?.name}</b>.</div>
                 : <div style={{ color: "var(--ink-2)" }}>No app is waiting with that code. It may have expired.</div>}
        {state === "done" ? <div style={{ color: "var(--ok)" }}>Approved. You can go back to Beam.</div>
          : <button className="btn" disabled={!pending || pending.status === "approved"} onClick={async () => { try { await approve({ userCode: code }); setState("done"); } catch { setState("error"); } }}>Approve</button>}
        <button className="btn ghost" onClick={onDone}>Not now</button>
      </div>
    </div>
  );
}

/** Signed in. Make sure there is at least one workspace, then show the shell. */
function Gate() {
  const me = useQuery(api.users.me);
  const workspaces = useQuery(api.workspaces.mine);
  const [approveCode, setApproveCode] = useState<string | null>(() => new URLSearchParams(location.search).get("approve"));
  if (approveCode) return <ApproveDesktop code={approveCode.toUpperCase()} onDone={() => { setApproveCode(null); history.replaceState(null, "", location.pathname); }} />;
  if (me === undefined || workspaces === undefined) return <div className="signin"><div className="k">…</div></div>;
  if (!me) return <div className="signin"><div className="k">no user</div></div>;
  if (workspaces.length === 0) return <FirstWorkspace />;
  return <Shell me={me} workspaces={workspaces} />;
}

function FirstWorkspace() {
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="signin">
      <div className="box">
        <h1 style={{ fontSize: 28 }}>Your first workspace</h1>
        <div style={{ color: "var(--ink-2)" }}>A team space with connected repos. Chats live inside it.</div>
        <div className="row" style={{ padding: 0, border: 0 }}><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" autoFocus /></div>
        <div className="row" style={{ padding: 0, border: 0 }}><span>Repo</span><input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name (optional)" /></div>
        <button className="btn" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); await create({ name: name.trim(), repo: repo.trim() || null }); }}>Create</button>
        <div className="k">{bridge() ? "desktop" : "browser"}</div>
      </div>
    </div>
  );
}

export type WorkspaceRow = { id: Id<"workspaces">; name: string; repos: string[] };
export function useDocumentTitle(t: string) { useEffect(() => { document.title = t; }, [t]); }
