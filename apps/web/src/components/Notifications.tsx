import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { ui } from "../lib/ui";
import { toast } from "./Toast";

export function Notifications({ activeChat }: { activeChat: string | null }) {
  const rows = useQuery(api.notifications.inbox);
  const preferences = useQuery(api.notifications.preferences);
  const claim = useMutation(api.notifications.claim);
  const read = useMutation(api.notifications.read);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(document.hasFocus() && !document.hidden);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => bridge()?.onNotificationClick?.((target) => {
    ui.openChat(target.workspaceId, target.chatId);
    void read({ id: target.id as Id<"notifications"> }).catch(() => {});
  }), [read]);
  useEffect(() => {
    for (const row of rows ?? []) {
      if (row.readAt !== null || pending.current.has(row._id)) continue;
      if (activeChat === row.chatId && focused) {
        pending.current.add(row._id);
        void read({ id: row._id }).catch(() => {}).finally(() => pending.current.delete(row._id));
        continue;
      }
      const native = bridge();
      if (!native?.notify || !preferences?.enabled || !preferences[row.kind] || row.deliveredAt !== null || Date.now() - row._creationTime > 10 * 60_000) continue;
      pending.current.add(row._id);
      void claim({ id: row._id }).then(async (claimed) => {
        if (claimed) await native.notify!({ id: row._id, title: row.title, body: row.body, silent: !preferences.sound, workspaceId: row.workspaceId, chatId: row.chatId });
      }).catch(() => {}).finally(() => pending.current.delete(row._id));
    }
  }, [rows, activeChat, focused, preferences, claim, read]);
  useEffect(() => { if (!open) return; const close = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [open]);
  const unread = (rows ?? []).filter((r) => r.readAt === null).length;
  return <div className="notification-center">
    <button className="nav-icon notification-toggle" title="Notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>{unread > 0 && <span className="notification-dot" />}</button>
    {open && <div className="notification-inbox" role="region" aria-label="Notifications">
      <div className="notification-heading">Notifications <button onClick={() => setOpen(false)} aria-label="Close notifications">×</button></div>
      {!rows?.length && <div className="notification-empty">You’re all caught up.</div>}
      {rows?.map((row) => <button key={row._id} className={`notification-row${row.readAt === null ? " unread" : ""}`} onClick={() => { ui.openChat(row.workspaceId, row.chatId); setOpen(false); void read({ id: row._id }).catch((e) => toast(e.message)); }}><b>{row.title}</b><span>{row.body}</span><small>{new Date(row._creationTime).toLocaleString()}</small></button>)}
    </div>}
  </div>;
}

export function NotificationSettings() {
  const prefs = useQuery(api.notifications.preferences);
  const save = useMutation(api.notifications.setPreferences);
  if (!prefs) return null;
  return <>
    <div className="sb-sec" style={{ padding: "12px 14px 4px" }}>Notifications</div>
    {([['enabled', 'Notify me'], ['completed', 'Work completed'], ['failed', 'Work failed or stopped'], ['input', 'Agent needs input'], ['sound', 'Play a sound']] as const).map(([key, label]) => <div className="row" key={key}><label><input type="checkbox" checked={prefs[key]} onChange={(e) => void save({ preferences: { ...prefs, [key]: e.target.checked } }).catch((e) => toast(e.message))} /> {label}</label></div>)}
    <div className="row"><span className="hint">Chats you create or participate in notify you automatically. Mute individual chats from their menu. Desktop alerts work while Beam is running, including with its window closed.</span></div>
    <div className="row"><button className="btn ghost" disabled={!bridge()?.notify} onClick={async () => { const sent = await bridge()?.notify?.({ id: `test-${Date.now()}`, title: "Beam notifications", body: "You’ll hear when your agent needs you.", silent: !prefs.sound }); toast(sent ? "Test sent. If no banner appears, allow Beam in macOS notification settings." : "Update the Beam desktop app to enable native notifications."); }}>Send test notification</button></div>
  </>;
}
