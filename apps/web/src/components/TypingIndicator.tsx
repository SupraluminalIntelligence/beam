import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { typingNames, typingLabel } from "../lib/typing";

export function useTyping(chatId: Id<"chats">) {
  const send = useMutation(api.presence.setTyping);
  const session = useRef(crypto.randomUUID());
  const last = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef(Promise.resolve());
  const publish = (active: boolean) => { queue.current = queue.current.catch(() => {}).then(async () => { await send({ chatId, session: session.current, active }); }).catch(() => {}); };
  const stop = () => { if (idle.current) clearTimeout(idle.current); if (last.current) { last.current = 0; publish(false); } };
  const change = (text: string) => {
    if (!text.trim()) { stop(); return; }
    if (!last.current || Date.now() - last.current > 1800) { last.current = Date.now(); publish(true); }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stop, 3000);
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", hidden); stop(); };
  }, [chatId, send]);
  return { change, stop };
}
export function TypingIndicator({ chatId, me, nameOf }: { chatId: Id<"chats">; me: string; nameOf: (login: string) => string }) {
  const rows = useQuery(api.presence.typingInChat, { chatId }) ?? [];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const names = typingNames(rows, me, now).map(nameOf);
  return <div className="typing-indicator" role="status" aria-live="polite" aria-atomic="true">{names.length > 0 && <><span className="typing-dots" aria-hidden="true">•••</span> {typingLabel(names)}</>}</div>;
}
