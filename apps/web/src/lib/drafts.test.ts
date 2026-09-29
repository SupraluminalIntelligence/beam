import { expect, it } from "vitest";
import { loadDraft, onDraftRestored, restoreDraft, saveDraft } from "./drafts";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

it("keeps each chat's draft, line breaks included, and forgets it once the composer is empty", () => {
  const store = memory();
  saveDraft("me", "a", "first line\nsecond @codex", store);
  saveDraft("me", "b", "other chat", store);
  expect(loadDraft("me", "a", store)).toBe("first line\nsecond @codex");
  expect(loadDraft("me", "b", store)).toBe("other chat");
  saveDraft("me", "a", "  \n", store);
  expect(loadDraft("me", "a", store)).toBe("");
  expect(store.m.size).toBe(1);
});

it("never shows one person's draft to someone else signed in on the same machine", () => {
  const store = memory();
  saveDraft("alice", "shared", "not sent yet", store);
  expect(loadDraft("bob", "shared", store)).toBe("");
  expect(loadDraft("alice", "shared", store)).toBe("not sent yet");
});

it("reads as empty when storage is unavailable or throws", () => {
  expect(loadDraft("me", "a", null)).toBe("");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  expect(loadDraft("me", "a", broken)).toBe("");
  expect(() => saveDraft("me", "a", "text", broken)).not.toThrow();
});

it("puts a failed send back ahead of newer text and tells the composer showing that chat", () => {
  const store = memory();
  const seen: string[] = [];
  const stop = onDraftRestored((userId, chatId, text) => { if (userId === "me" && chatId === "a") seen.push(text); });
  saveDraft("me", "a", "typed since", store);
  restoreDraft("me", "a", "failed message", store);
  expect(loadDraft("me", "a", store)).toBe("failed message\ntyped since");
  expect(seen).toEqual(["failed message\ntyped since"]);
  stop();
  restoreDraft("me", "b", "elsewhere", store);
  expect(seen).toHaveLength(1);
  expect(loadDraft("me", "b", store)).toBe("elsewhere");
});
