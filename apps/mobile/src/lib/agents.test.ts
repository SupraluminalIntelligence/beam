import { describe, expect, it } from "vitest";
import { agentName, chatStatus, ownerOf } from "./agents";

const names: Record<string, string> = { noah: "Noah Park", apekshik: "Apekshik" };
const nameOf = (l: string) => names[l] ?? l;

describe("agent naming", () => {
  it("names an agent by whose account it runs on", () => {
    expect(agentName("claude", "apekshik", "apekshik", nameOf)).toBe("Your Claude Code");
    expect(agentName("codex", "noah", "apekshik", nameOf)).toBe("Noah's Codex");
  });
  it("prefers the reported account owner over the dispatcher", () => {
    expect(ownerOf({ execution: { accountOwner: "noah" }, dispatchedBy: "apekshik" })).toBe("noah");
    expect(ownerOf({ execution: null, dispatchedBy: "apekshik" })).toBe("apekshik");
  });
});

describe("chat status", () => {
  const run = (state: string, t: number) => ({ state, startedAt: t, _creationTime: t, label: "Your Claude Code" });
  it("says nothing when nothing needs you", () => expect(chatStatus([run("landed", 1)], false).state).toBe("none"));
  it("shows a live run", () => expect(chatStatus([run("landed", 1), run("working", 2)], false)).toEqual({ state: "working", agent: "Your Claude Code", since: 2 }));
  it("puts waiting on you above working", () => expect(chatStatus([run("working", 2)], true).state).toBe("waiting"));
  it("shows a failure only when it is the latest run", () => {
    expect(chatStatus([run("failed", 1), run("landed", 2)], false).state).toBe("none");
    expect(chatStatus([run("landed", 1), run("interrupted", 2)], false).state).toBe("failed");
  });
});
