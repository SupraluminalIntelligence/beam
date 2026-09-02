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

function SignIn() {
  const { signIn } = useAuthActions();
  const [busy, setBusy] = useState(false);
  return (
    <div className="signin">
      <div className="box">
        <div className="k" style={{ letterSpacing: ".12em", textTransform: "uppercase", textAlign: "left" }}>Supraluminal Intelligence</div>
        <h1>Beam</h1>
        <div style={{ color: "var(--ink-2)" }}>Argue it out. Then beam it.</div>
        <button className="btn" disabled={busy} onClick={() => { setBusy(true); void signIn("github"); }}>Continue with GitHub</button>
        <button className="btn ghost" disabled={busy} onClick={() => { setBusy(true); void signIn("anonymous"); }}>Continue as a guest</button>
        <div className="k">GitHub sign-in needs the OAuth app configured on the deployment. Guests can do everything except own a runner.</div>
      </div>
    </div>
  );
}

/** Signed in. Make sure there is at least one workspace, then show the shell. */
function Gate() {
  const me = useQuery(api.users.me);
  const workspaces = useQuery(api.workspaces.mine);
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
