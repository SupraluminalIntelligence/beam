/** `@handle` at the start of the text or after whitespace. Shared by every composer and the layer API. */
export const MENTION = /(^|\s)@([a-z0-9-]+)\b/gi;

/** The first mentioned handle that is one of `handles` (an agent in the chat), lowercased, or null. */
export function firstMention(text: string, handles: ReadonlySet<string>): string | null {
  for (const m of text.matchAll(MENTION)) { const h = m[2]!.toLowerCase(); if (handles.has(h)) return h; }
  return null;
}
