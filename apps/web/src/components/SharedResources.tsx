import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { toast } from "./Toast";

export function SharedResources({ chatId }: { chatId: Id<"chats"> }) {
  const resources = useQuery(api.resources.list, { chatId });
  const access = useMutation(api.resources.setAccess);
  const [port, setPort] = useState(""); const [busy, setBusy] = useState(false);
  const share = async (kind: "folder" | "service") => {
    const b = bridge(); if (!b?.shareResource) return;
    setBusy(true);
    try {
      if (kind === "folder") { const path = await b.pickFolder(); if (path) await b.shareResource({ chatId, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project", resource: { kind, path } }); }
      else { await b.shareResource({ chatId, name: `Preview · port ${port}`, resource: { kind, port: Number(port) } }); setPort(""); }
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="shared-resources" aria-label="Shared machines and resources">
    <h3>Shared resources</h3><p className="context-help">Folders and previews stay on their host machines. Agents access them using their own accounts.</p>
    {resources?.map(r => <div className="shared-resource" key={r._id}>
      <strong>{r.name}</strong><span>{r.ownerName} · {r.machineName} · {r.online ? "online" : "offline"}</span><span>{r.shared ? "Workspace access" : "Only you"}{r.kind === "folder" ? " · commands run in an isolated container" : " · view-only preview; refresh to update"}</span>
      {r.kind === "service" && bridge()?.openResourcePreview && <button className="context-add" disabled={!r.online} onClick={async () => { try { const url = await bridge()!.openResourcePreview!(chatId, r._id); await bridge()!.openExternal(url); } catch (e) { toast((e as Error).message); } }}>Open preview</button>}
      {r.mine && <div className="shared-resource-actions"><label><input type="checkbox" checked={r.shared} onChange={e => void access({ id: r._id, shared: e.target.checked }).catch(e => toast(e.message))} />Share with workspace</label>{r.kind === "folder" && <label><input type="checkbox" checked={r.allowInstall} onChange={e => void access({ id: r._id, allowInstall: e.target.checked }).catch(e => toast(e.message))} />Allow project dependency installation</label>}<button className="ctl" onClick={() => void access({ id: r._id, revoked: true }).catch(e => toast(e.message))}>Remove access</button></div>}
    </div>)}
    {bridge()?.shareResource && <div className="shared-resource-actions"><button className="context-add" disabled={busy} onClick={() => void share("folder")}>Add local folder</button><input type="number" aria-label="Preview port" min={1024} max={65535} placeholder="3000" value={port} onChange={e => setPort(e.target.value)} /><button className="context-add" disabled={busy || !Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535} onClick={() => void share("service")}>Share preview</button></div>}
  </section>;
}

export function ResourceSharingPolicy() {
  const policy = useQuery(api.resources.sharingPolicy); const save = useMutation(api.resources.setSharingPolicy);
  return <div className="row connection-policy"><span>New workspace folders</span><select aria-label="Workspace resource sharing" value={policy ?? "auto"} disabled={!policy} onChange={e => void save({ policy: e.target.value as "auto" | "ask" }).catch(e => toast(e.message))}><option value="auto">Share automatically</option><option value="ask">Keep private until I approve</option></select></div>;
}
