/**
 * Unsent composer text, one per person and chat, kept in this browser so switching chats or reloading never loses it.
 * Keyed by user too: someone else signing in on this machine never sees (or sends) your draft in a chat you share.
 * Attachments are drafts on the server already (files.drafts); this is only the text.
 */
const PREFIX = "beam.draft.v1:";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => { try { return localStorage; } catch { return null; } };

export function loadDraft(userId: string, chatId: string, store: Store | null = storage()): string {
  try { return store?.getItem(`${PREFIX}${userId}:${chatId}`) ?? ""; } catch { return ""; }
}

/** Whitespace alone is not a draft: an empty composer leaves nothing behind. */
export function saveDraft(userId: string, chatId: string, text: string, store: Store | null = storage()) {
  try {
    if (text.trim()) store?.setItem(`${PREFIX}${userId}:${chatId}`, text);
    else store?.removeItem(`${PREFIX}${userId}:${chatId}`);
  } catch {}
}
