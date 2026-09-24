import { Notification } from "electron";
export type Notice = { id: string; title: string; body: string; silent: boolean; workspaceId?: string; chatId?: string; messageId?: string };
const active = new Map<string, { banner: Notification; result: Promise<boolean> }>();

/** Report native acceptance rather than marking delivery before show() can fail. */
export function showNotification(value: Notice, onClick: () => void): Promise<boolean> {
  const existing = active.get(value.id);
  if (existing) return existing.result;
  if (!Notification.isSupported()) return Promise.resolve(false);
  try {
    const banner = new Notification({ title: value.title, body: value.body, silent: value.silent, ...(process.platform === "darwin" && !value.silent ? { sound: "default" } : {}) });
    let settle!: (accepted: boolean) => void;
    const result = new Promise<boolean>(resolve => { settle = resolve; });
    const timer = setTimeout(() => { active.delete(value.id); banner.close(); settle(false); }, 10_000);
    const finish = (accepted: boolean) => { clearTimeout(timer); settle(accepted); };
    active.set(value.id, { banner, result });
    banner.once("show", () => finish(true));
    banner.once("failed", () => { active.delete(value.id); finish(false); });
    banner.once("close", () => { active.delete(value.id); finish(false); });
    banner.on("click", onClick);
    try { banner.show(); } catch { active.delete(value.id); finish(false); }
    // Retain recent banners for click handling without growing indefinitely.
    if (active.size > 200) { const oldest = active.keys().next().value; if (oldest) active.delete(oldest); }
    return result;
  } catch { return Promise.resolve(false); }
}
