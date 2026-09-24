import { useEffect, useId, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "./Toast";

export function MachineNameSetting({ runner, local }: { runner: { id: Id<"runners">; name: string; hostname: string; online: boolean }; local: boolean }) {
  const save = useMutation(api.runners.rename);
  const id = useId();
  const [draft, setDraft] = useState(runner.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(runner.name); setError(""); }, [runner.name]);
  const changed = draft.trim() !== runner.name;
  const cancel = () => { setDraft(runner.name); setError(""); };
  return <form className="row machine-name-setting" onSubmit={async e => {
    e.preventDefault();
    if (busy || !changed || !draft.trim()) return;
    setBusy(true); setError("");
    try { await save({ runnerId: runner.id, name: draft.trim() }); setDraft(draft.trim()); toast("Machine name saved"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save machine name"); }
    finally { setBusy(false); }
  }}>
    <label htmlFor={id}>{local ? "This machine’s name" : "Machine name"}</label>
    <div>
      <div className="machine-name-controls">
        <input id={id} type="text" value={draft} maxLength={80} disabled={busy} placeholder="Office Mac" aria-describedby={`${id}-help`} onChange={e => { setDraft(e.target.value); setError(""); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }} />
        <button className="btn ghost" type="submit" disabled={busy || !changed || !draft.trim()}>{busy ? "Saving…" : "Save"}</button>
        {changed && <button className="btn ghost" type="button" disabled={busy} onClick={cancel}>Cancel</button>}
      </div>
      <p className="hint" id={`${id}-help`}>{runner.hostname} · {runner.online ? "Online" : "Offline"}{local ? " · This machine" : ""}</p>
      {error && <p className="connection-error" role="alert">{error}</p>}
    </div>
  </form>;
}
