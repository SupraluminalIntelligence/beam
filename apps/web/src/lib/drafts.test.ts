import { expect, it } from "vitest";
import { loadDraft, saveDraft } from "./drafts";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

it("keeps each chat's draft, line breaks included, and forgets it once the composer is empty", () => {
  const store = memory();
  saveDraft("a", "first line\nsecond @codex", store);
  saveDraft("b", "other chat", store);
  expect(loadDraft("a", store)).toBe("first line\nsecond @codex");
  expect(loadDraft("b", store)).toBe("other chat");
  saveDraft("a", "  \n", store);
  expect(loadDraft("a", store)).toBe("");
  expect(store.m.size).toBe(1);
});

it("reads as empty when storage is unavailable or throws", () => {
  expect(loadDraft("a", null)).toBe("");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  expect(loadDraft("a", broken)).toBe("");
  expect(() => saveDraft("a", "text", broken)).not.toThrow();
});
