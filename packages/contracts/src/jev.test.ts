import { afterEach, expect, it, vi } from "vitest";
import { askJev, jevRequest, parseJev } from "./jev";
const context = { title: "chat", repo: null, agents: [{ handle: "none", name: "Codex", model: "Astra" }], liveHandle: null, transcript: [], message: { who: "george", text: "codex fix it" } };
const response = (confidence = 0.99, choice = "agent_0") => ({ model: "jev-test", answers: { route: { type: "choice", choice, confidence, probabilities: { no_action: 0.01, agent_0: 0.99 } } } });
afterEach(() => vi.unstubAllGlobals());
it("uses unambiguous option IDs even for an agent named none", () => {
  expect(Object.keys(jevRequest(context, "rules").questions.route.criteria)).toEqual(["no_action", "agent_0"]);
  expect(parseJev(response(), context, 0.9).agent).toBe("none");
});
it("abstains on uncertainty and rejects malformed or unknown choices", () => {
  expect(parseJev(response(0.5), context, 0.9).agent).toBeNull();
  expect(() => parseJev(response(0.99, "attacker"), context, 0.9)).toThrow();
  expect(() => parseJev(response(), context, NaN)).toThrow();
  expect(() => parseJev({ answers: {} }, context, 0.9)).toThrow();
});
it("does not echo sensitive provider error bodies", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("secret key in error", { status: 401 })));
  await expect(askJev("secret", context, "rules")).rejects.toThrow(/^Jev HTTP 401$/);
});
