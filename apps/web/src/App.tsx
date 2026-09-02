import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, AuthLoading, Unauthenticated, useConvex, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { bridge } from "./bridge";
import { Shell } from "./components/Shell";
import { Toast, toast } from "./components/Toast";

/** Where the hosted web app lives. The desktop app sends browser-side flows (sign-in, GitHub connect) here. */
export const HOSTED_URL = (import.meta.env["VITE_SITE_URL"] as string | undefined) ?? "https://beam-nine-ruby.vercel.app";

/**
 * ?connect=github: run the GitHub authorization (with the repo scope) right away, in the browser, whatever
 * the current session is. Beam stores the token on the user, and every signed-in client of that user,
 * including the desktop app, can list repos from then on. ?connected=github is the landing page after.
 */
function ConnectGitHub() {
  const { signIn } = useAuthActions();
  const params = new URLSearchParams(location.search);
  const connect = params.get("connect") === "github", connected = params.get("connected") === "github";
  const started = useRef(false);
  useEffect(() => { if (connect && !started.current) { started.current = true; void signIn("github", { redirectTo: "/?connected=github" }); } }, [connect, signIn]);
  if (!connect && !connected) return null;
  return (
    <div className="signin"><div className="card-ish">
      <div className="brand"><span className="eyebrow">Supraluminal Intelligence</span><h1>Beam</h1></div>
      {connect
        ? <div style={{ color: "var(--ink-2)" }}>Connecting GitHub… you will be sent to GitHub to allow repo access.</div>
        : <><div style={{ color: "var(--ink-2)" }}>GitHub connected. Beam can now list the repos you can push to.</div><div className="k">Go back to Beam; the repo picker fills in by itself. You can close this tab.</div>
            <button className="btn ghost" onClick={() => { history.replaceState(null, "", location.pathname); location.reload(); }}>Stay here</button></>}
    </div></div>
  );
}

export function App() {
  const p = new URLSearchParams(location.search);
  if (p.get("connect") === "github" || p.get("connected") === "github") return <ConnectGitHub />;
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
  const convex = useConvex();
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
    // Wait for the browser to approve, then sign in exactly once. A credentials sign-in
    // resolves with signingIn:false when the code is not approved yet; it does not throw.
    while (Date.now() - started < 15 * 60_000) {
      await new Promise((res) => setTimeout(res, 2000));
      const st = await convex.query(api.runnerAuth.pending, { userCode: d.userCode }).catch(() => null);
      if (!st) { toast("That sign-in code expired. Try again."); break; }
      if (st.status !== "approved") continue;
      const r = await signIn("device", { deviceCode: d.deviceCode }).catch((e) => { toast(String((e as Error).message).slice(0, 120)); return { signingIn: false }; });
      if (r.signingIn) return;
      toast("Sign-in did not complete. Try again."); break;
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
  if (workspaces.length === 0) return <AutoWorkspace login={me.githubLogin} />;
  return <Shell me={me} workspaces={workspaces} />;
}

/** No setup screen. The first sign-in gets a personal workspace named after the person; repos and people come later. */
function AutoWorkspace({ login }: { login: string }) {
  const create = useMutation(api.workspaces.create);
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; void create({ name: login, repo: null }); }, [create, login]);
  return <div className="signin"><div className="k">setting up your workspace…</div></div>;
}

export type WorkspaceRow = { id: Id<"workspaces">; name: string; repos: string[] };
export function useDocumentTitle(t: string) { useEffect(() => { document.title = t; }, [t]); }
