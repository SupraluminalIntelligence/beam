/**
 * Unsent composer text, one per chat, kept in this browser so switching chats or reloading never loses it.
 * Attachments are drafts on the server already (files.drafts); this is only the text.
 */
const PREFIX = "beam.draft.v1:";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => { try { return localStorage; } catch { return null; } };

export function loadDraft(chatId: string, store: Store | null = storage()): string {
  try { return store?.getItem(PREFIX + chatId) ?? ""; } catch { return ""; }
}

/** Whitespace alone is not a draft: an empty composer leaves nothing behind. */
export function saveDraft(chatId: string, text: string, store: Store | null = storage()) {
  try {
    if (text.trim()) store?.setItem(PREFIX + chatId, text);
    else store?.removeItem(PREFIX + chatId);
  } catch {}
}
