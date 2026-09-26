import { useEffect, useState } from "react";

type U = { state: "none" | "checking" | "available" | "downloading" | "ready" | "installing" | "error"; version: string | null; percent: number; message: string | null };
type Bridge = { updateStatus?: () => Promise<U>; updateDownload?: () => Promise<void>; updateInstall?: () => Promise<void>; onUpdate?: (cb: (u: U) => void) => () => void };
const bridge = () => (window as unknown as { beam?: Bridge }).beam;

/** The update pill next to the account row. Appears when a newer Beam exists; one click downloads, one more restarts into it. */
export function UpdatePill() {
  const [u, setU] = useState<U | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b?.onUpdate) return;
    void b.updateStatus?.().then(setU).catch(() => {});
    return b.onUpdate(setU);
  }, []);
  if (!u || u.state === "none" || u.state === "checking") return null;
  const b = bridge();
  if (u.state === "available" || u.state === "error") return <button className="upd" title={u.state === "error" ? `Update failed: ${u.message ?? "unknown"} · click to retry` : `Beam ${u.version} is available · click to download`} onClick={() => void b?.updateDownload?.()}>{u.state === "error" ? "retry update" : "update"}</button>;
  if (u.state === "downloading") return <span className="upd busy" title={`Downloading Beam ${u.version}`}>{u.percent}%</span>;
  if (u.state === "installing") return <button className="upd busy" disabled aria-live="polite">restarting…</button>;
  return <button className="upd ready" title={`Beam ${u.version} is downloaded · click to restart into it`} onClick={() => void b?.updateInstall?.().catch((error: unknown) => setU({ ...u, state: "error", message: error instanceof Error ? error.message : String(error) }))}>restart to update</button>;
}
