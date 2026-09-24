import { expect, it } from "vitest";
import { mentionTargets } from "./mentionTargets";
const people = [{ login: "noah-dev", name: "Noah Smith" }, { login: "apek", name: "Apekshik Panigrahi" }];
it("resolves logins and unique names case-insensitively and deduplicates aliases", () => {
  expect(mentionTargets("@Noah please check (@noah-dev), @Noah-Smith! @apek", people)).toEqual(["noah-dev", "apek"]);
});
it("does not guess ambiguous names; exact logins win", () => {
  const ambiguous = [...people, { login: "noah-other", name: "Noah Jones" }];
  expect(mentionTargets("@Noah", ambiguous)).toEqual([]);
  expect(mentionTargets("@noah-dev", ambiguous)).toEqual(["noah-dev"]);
  expect(mentionTargets("@noah", [...ambiguous, { login: "noah" }])).toEqual(["noah"]);
});
it("ignores email, URLs, code, unknown people and agent handles", () => {
  expect(mentionTargets("me@Noah.com https://example.com/@Noah `@Noah`\n```ts\n@Noah\n```\n~~~\n@apek\n~~~\n@stranger @codex", [...people, { login: "codex" }], ["codex"])).toEqual([]);
  expect(mentionTargets("@Noah\n```\n@apek", people)).toEqual(["noah-dev"]);
});
