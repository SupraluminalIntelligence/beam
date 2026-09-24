import { expect, it } from "vitest";
import { resolveConnection, type ConnectionRunner } from "./connections";

const status = (connectionId = "default", extra = {}) => ({ harness: "codex", auth: "authenticated", connectionId, connectionName: connectionId, isDefault: connectionId === "default", email: "same@example.test", plan: "Pro", ...extra });
const machine = (id: string, statuses = [status()], extra = {}): ConnectionRunner => ({ _id: id, name: id, ownerLogin: "apex", online: true, lastSeen: 100000, harnesses: statuses, ...extra });
const opts = { login: "apex", harness: "codex", members: ["apex", "noah"], now: 100001, localRunnerId: "personal" };
const hosts = [machine("work"), machine("studio"), machine("windows"), machine("personal")];

it("defaults to the actual client machine among four online machines", () => {
  expect(resolveConnection(hosts, opts).runner._id).toBe("personal");
  expect(resolveConnection(hosts, { ...opts, localRunnerId: "windows" }).runner._id).toBe("windows");
});
it("does not guess a machine for a browser or fall back from an offline local host", () => {
  expect(() => resolveConnection(hosts, { ...opts, localRunnerId: undefined })).toThrow("no local runner");
  expect(() => resolveConnection([machine("personal", [status()], { online: false }), machine("work")], opts)).toThrow("offline");
});
it("selects a named local default and rejects ambiguous defaults", () => {
  const profiles = [status("default", { isDefault: false }), status("work-account", { isDefault: true })];
  expect(resolveConnection([machine("personal", profiles)], opts).status.connectionId).toBe("work-account");
  expect(() => resolveConnection([machine("personal", [status(), status("work-account", { isDefault: true })])], opts)).toThrow("default account");
});
it("honors an explicit remote connection without email-based account merging", () => {
  const result = resolveConnection(hosts, { ...opts, choice: { runnerId: "work", connectionId: "default" } });
  expect(result.runner._id).toBe("work");
});
it("prefers a verified local instance of the selected provider account", () => {
  const runners = [machine("work", [status("work-id", { accountIdentity: "provider:account:org" })]), machine("personal", [status("local-id", { accountIdentity: "provider:account:org" })])];
  expect(resolveConnection(runners, { ...opts, choice: { runnerId: "work", connectionId: "work-id" } }).status.connectionId).toBe("local-id");
});
it("does not bypass sign-in or change accounts when a selection is unavailable", () => {
  expect(() => resolveConnection([machine("personal", [status("default", { auth: "unauthenticated" })])], opts)).toThrow("not signed in");
  expect(() => resolveConnection(hosts, { ...opts, choice: { runnerId: "work", connectionId: "removed" } })).toThrow("unavailable");
});
it("requires account sharing and workspace membership, even for an explicit choice", () => {
  const noah = machine("noah", [status()], { ownerLogin: "noah" });
  const options = { ...opts, choice: { runnerId: "noah", connectionId: "default" } };
  expect(() => resolveConnection([noah], options)).toThrow("no longer shared");
  expect(resolveConnection([{ ...noah, allowSharedRuns: true }], options).runner.ownerLogin).toBe("noah");
  expect(() => resolveConnection([{ ...noah, allowSharedRuns: true }], { ...options, members: ["apex"] })).toThrow("unavailable");
  expect(() => resolveConnection([{ ...noah, allowSharedRuns: true }], { ...opts, localRunnerId: "noah" })).toThrow("default account");
});
it("treats old single-account runner reports as the local default profile", () => {
  expect(resolveConnection([machine("personal", [{ harness: "codex", auth: "authenticated" } as any])], opts).status.connectionId).toBe("default");
});

it("keeps an explicit local choice when several profiles have the same verified account", () => {
  const runners = [machine("personal", [status("one", { accountIdentity: "id" }), status("two", { accountIdentity: "id" })])];
  expect(resolveConnection(runners, { ...opts, choice: { runnerId: "personal", connectionId: "two" } }).status.connectionId).toBe("two");
});
