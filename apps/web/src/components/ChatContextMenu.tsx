import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { ui, useUi } from "../lib/ui";
import { toast } from "./Toast";

export type ChatMenuTarget = { chat: Doc<"chats">; x: number; y: number; trigger: HTMLButtonElement };

export function ChatContextMenu({ target, onClose, userId }: { target: ChatMenuTarget; onClose: () => void; userId: string }) {
  const remove = useMutation(api.chats.remove);
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chat = target.chat;
  const muted = useQuery(api.notifications.muted, { chatId: chat._id });
  const setMuted = useMutation(api.notifications.setMuted);
  const pinned = (useUi().pinnedChats[userId] ?? []).some(p => p.chatId === chat._id);

  useEffect(() => {
    return () => { if (target.trigger.isConnected) target.trigger.focus(); };
  }, [target.trigger]);

  useEffect(() => {
    if (confirm) { dialog.current?.showModal(); return; }
    menu.current?.querySelector("button")?.focus();
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const buttons = Array.from(menu.current?.querySelectorAll("button") ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const dismiss = () => onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [confirm, onClose]);

  async function deleteChat() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await remove({ chatId: chat._id });
      ui.closeChat(chat.workspaceId, chat._id);
      if (pinned) ui.togglePin(userId, chat.workspaceId, chat._id);
      toast("Chat deleted");
      onClose();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^.*Uncaught Error: /s, "").split("\n")[0] ?? "Could not delete chat.");
      setBusy(false);
    }
  }

  return createPortal(confirm ? (
    <dialog ref={dialog} className="modal chat-delete-dialog" aria-labelledby="chat-delete-title" aria-describedby="chat-delete-description" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} onKeyDown={e => e.stopPropagation()}>
      <div className="m-h" id="chat-delete-title">Delete chat?</div>
      <div className="chat-delete-body">
        <p id="chat-delete-description">Delete “{chat.title}”{chat.private ? "?" : " for everyone in this workspace?"} It will be removed from the chat list and open tabs.</p>
        {error && <p className="chat-delete-error" role="alert">{error}</p>}
      </div>
      <div className="m-f">
        <button className="btn ghost" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={() => void deleteChat()}>{busy ? "Deleting…" : "Delete chat"}</button>
      </div>
    </dialog>
  ) : (
    <div ref={menu} className="chat-context-menu" role="menu" aria-label={`Actions for ${chat.title}`} style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - 188)), top: Math.max(8, Math.min(target.y, window.innerHeight - 130)) }} onContextMenu={e => e.preventDefault()}>
      <button role="menuitem" onClick={() => { ui.togglePin(userId, chat.workspaceId, chat._id); onClose(); }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-4 1-4 4-1 5-3-3-6 6 6-6-3-3 5-1 4-4 1-4Z" /></svg>
        {pinned ? "Unpin chat" : "Pin chat"}
      </button>
      <button role="menuitem" disabled={muted === undefined || busy} onClick={async () => {
        if (muted === undefined || busy) return;
        setBusy(true);
        try {
          await setMuted({ chatId: chat._id, muted: !muted });
          toast(muted ? "Chat unmuted" : "Chat muted");
          onClose();
        } catch (e) { toast(e instanceof Error ? e.message : "Could not update notifications"); }
        finally { setBusy(false); }
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />{muted && <path d="m3 3 18 18" />}</svg>
        {muted ? "Unmute chat" : "Mute chat"}
      </button>
      <button role="menuitem" className="chat-delete-action" onClick={() => setConfirm(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg>
        Delete chat
      </button>
    </div>
  ), document.body);
}
