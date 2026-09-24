import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "me" }));
import { me, byLogins, setUsername } from "./users";

function fixture() {
  const users = [{ _id: "me", githubLogin: "apekshik", name: "Apekshik Panigrahi", username: undefined as string | undefined }, { _id: "noah", githubLogin: "noah-dev", name: "Noah Example", username: "noah" }];
  const db = {
    get: async (id: string) => users.find(u => u._id === id),
    patch: async (id: string, patch: object) => Object.assign(users.find(u => u._id === id)!, patch),
    query: (table: string) => ({
      collect: async () => [],
      withIndex: (_: string, filter: (q: any) => any) => { let key: string; let value: string; filter({ eq: (k: string, v: string) => { key = k; value = v; } }); return { first: async () => table === "users" ? users.find(u => (u as any)[key] === value) ?? null : null }; },
    }),
  };
  return { users, ctx: { db } };
}
const call = (fn: any, ctx: any, args = {}) => fn._handler(ctx, args);
it("shows handles instead of full names and persists a custom username without changing identity", async () => {
  const { ctx, users } = fixture();
  expect((await call(me, ctx)).name).toBe("apekshik");
  await call(setUsername, ctx, { username: " @Apek " });
  expect((await call(me, ctx)).name).toBe("apek");
  expect(users[0]).toMatchObject({ githubLogin: "apekshik", name: "Apekshik Panigrahi", username: "apek" });
  expect((await call(byLogins, ctx, { logins: ["apekshik", "noah-dev"] }))["noah-dev"].name).toBe("noah");
});
it("rejects duplicate usernames, another user's login and reserved agent handles", async () => {
  const { ctx } = fixture();
  for (const username of ["noah", "noah-dev", "codex", "claude"]) await expect(call(setUsername, ctx, { username })).rejects.toThrow();
  await expect(call(setUsername, ctx, { username: "apekshik" })).resolves.toBe("apekshik");
});
it("rejects invalid handles", async () => {
  const { ctx } = fixture();
  for (const username of ["", "a", "full name", "bad!", "-start", "end-", "a".repeat(33)]) await expect(call(setUsername, ctx, { username })).rejects.toThrow("2–32");
});
