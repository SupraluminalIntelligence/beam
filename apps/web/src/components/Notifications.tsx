import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { ui } from "../lib/ui";
import { toast } from "./Toast";
import { NotificationDelivery } from "../lib/notificationDelivery";

export function Notifications({ activeChat }: { activeChat: string | null }) {
  const rows = useQuery(api.notifications.inbox);
  const preferences = useQuery(api.notifications.preferences);
  const reserve = useMutation(api.notifications.reserve);
  const finishDelivery = useMutation(api.notifications.finishDelivery);
  const read = useMutation(api.notifications.read);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(document.hasFocus() && !document.hidden);
  const pending = useRef(new Set<string>());
  const delivery = useRef(new NotificationDelivery());
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setTick(n => n + 1), 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => bridge()?.onNotificationClick?.((target) => {
    ui.openMessage(target.workspaceId, target.chatId, target.messageId);
    void read({ id: target.id as Id<"notifications"> }).catch(() => {});
  }), [read]);
  useEffect(() => {
    for (const row of rows ?? []) {
      if (row.readAt !== null || pending.current.has(row._id)) continue;
      if (row.kind !== "mention" && activeChat === row.chatId && focused) {
        pending.current.add(row._id);
        void read({ id: row._id }).catch(() => {}).finally(() => pending.current.delete(row._id));
        continue;
      }
      const native = bridge();
      // A pause holds alerts for everything that arrived during it, even after it ends; the inbox still shows them.
      if (!native?.notify || !preferences?.enabled || !preferences[row.kind] || row.deliveredAt !== null || Date.now() - row._creationTime > 10 * 60_000 || row._creationTime < (preferences.pausedUntil ?? 0)) continue;
      void delivery.current.deliver(row._id, {
        reserve: token => reserve({ id: row._id, token }),
        show: () => activeChat === row.chatId && focused ? Promise.resolve(true) : native.notify!({ id: row._id, title: row.title, body: row.body, silent: !preferences.sound, workspaceId: row.workspaceId, chatId: row.chatId, ...(row.messageId ? { messageId: row.messageId } : {}) }),
        finish: (token, accepted) => finishDelivery({ id: row._id, token, accepted }),
      });
    }
  }, [rows, activeChat, focused, preferences, reserve, finishDelivery, read, tick]);
  useEffect(() => { if (!open) return; const close = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [open]);
  const unread = (rows ?? []).filter((r) => r.readAt === null).length;
  return <div className="notification-center">
    <button className="nav-icon notification-toggle" title="Notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>{unread > 0 && <span className="notification-dot" />}</button>
    {open && <div className="notification-inbox" role="region" aria-label="Notifications">
      <div className="notification-heading">Notifications <button onClick={() => setOpen(false)} aria-label="Close notifications">×</button></div>
      {!rows?.length && <div className="notification-empty">You’re all caught up.</div>}
      {rows?.map((row) => <button key={row._id} className={`notification-row${row.readAt === null ? " unread" : ""}`} onClick={() => { ui.openMessage(row.workspaceId, row.chatId, row.messageId); setOpen(false); void read({ id: row._id }).catch((e) => toast(e.message)); }}><b>{row.title}</b><span>{row.body}</span><small>{new Date(row._creationTime).toLocaleString()}</small></button>)}
    </div>}
  </div>;
}

/** 9am tomorrow, local time. */
function tomorrowMorning(now: number) { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
const clock = (t: number) => new Date(t).toLocaleString([], new Date(t).toDateString() === new Date().toDateString() ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });

/** Desktop alerts on hold, or null. Re-renders when the pause runs out. */
export function usePause() {
  const prefs = useQuery(api.notifications.preferences);
  const [, setTick] = useState(0);
  const until = prefs?.pausedUntil ?? 0;
  useEffect(() => { if (until <= Date.now()) return; const t = window.setTimeout(() => setTick(n => n + 1), Math.min(until - Date.now() + 500, 2 ** 31 - 1)); return () => window.clearTimeout(t); }, [until]);
  return until > Date.now() ? until : null;
}

/** Pause and resume, shared by the account menu and the Notifications page. */
export function PauseControls({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const pause = useMutation(api.notifications.pause);
  const until = usePause();
  const set = (t: number | null) => { void pause({ until: t }).then(() => toast(t ? `Notifications paused until ${clock(t)}` : "Notifications resumed")).catch((e) => toast(e.message)); onDone?.(); };
  return until
    ? <span className="pause-ctl"><span className="hint">until {clock(until)}</span><button className="btn ghost" onClick={() => set(null)}>Resume</button></span>
    : <span className="pause-ctl"><button className="btn ghost" title="Pause for 1 hour" onClick={() => set(Date.now() + 60 * 60_000)}>{compact ? "1h" : "1 hour"}</button><button className="btn ghost" title="Pause until 9am tomorrow" onClick={() => set(tomorrowMorning(Date.now()))}>{compact ? "Tomorrow" : "Until tomorrow"}</button></span>;
}

export function NotificationSettings() {
  const prefs = useQuery(api.notifications.preferences);
  const save = useMutation(api.notifications.setPreferences);
  if (!prefs) return null;
  return <>
    <div className="row"><span>Pause alerts</span><PauseControls /></div>
    {([['enabled', 'Desktop notifications'], ['mention', 'Mentions'], ['completed', 'Work completed'], ['failed', 'Work failed or stopped'], ['input', 'Agent needs input'], ['sound', 'Play a sound']] as const).map(([key, label]) => <div className="row check" key={key}><label><input type="checkbox" checked={prefs[key]} onChange={(e) => void save({ preferences: { ...prefs, [key]: e.target.checked } }).catch((e) => toast(e.message))} /> {label}</label></div>)}
    <div className="row notification-foot"><span className="hint">Alerts show even with the window closed. Mute a chat from its menu.</span><button className="btn ghost" disabled={!bridge()?.notify} onClick={async () => { const sent = await bridge()?.notify?.({ id: `test-${Date.now()}`, title: "Beam notifications", body: "Mentions and agent updates can alert you here.", silent: !prefs.sound }); toast(sent ? "Test sent. If no banner appears, allow Beam in macOS notification settings." : "Desktop notification failed. Check Beam’s notification permission in macOS Settings."); }}>Send test notification</button></div>
  </>;
}
