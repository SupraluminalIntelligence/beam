import { it, expect, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "u1" }));
// The runner's token check is compute.runAccess's own concern; here a run is reachable with token "t".
vi.mock("./compute", () => ({ runAccess: async (_ctx: unknown, token: string, runId: string) => {
  if (token !== "t") throw new Error("Invalid runner token");
  return { run: { _id: runId, chatId: "chat" } };
} }));
import { add, forRun } from "./shows";

function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: "u1", githubLogin: "apek" }], members: [{ workspaceId: "ws", githubLogin: "apek" }],
    chats: [{ _id: "chat", workspaceId: "ws", private: false, members: ["apek"] }], runs: [{ _id: "run", chatId: "chat" }], machineShows: [],
  };
  const blobs: Record<string, { contentType?: string; size: number }> = {
    png: { contentType: "image/png", size: 40_000 }, svg: { contentType: "image/svg+xml", size: 9_000 },
    big: { contentType: "image/png", size: 11 * 1024 * 1024 }, exe: { contentType: "application/octet-stream", size: 100 },
  };
  const matches = (t: string, fn: any) => { const f: [string, unknown][] = []; const q = { eq: (k: string, v: unknown) => { f.push([k, v]); return q; } }; fn(q); return (tables[t] ?? []).filter(r => f.every(([k, v]) => r[k] === v)); };
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    query: (t: string) => ({ withIndex: (_: string, fn: any) => ({ collect: async () => matches(t, fn), first: async () => matches(t, fn)[0] ?? null, unique: async () => matches(t, fn)[0] ?? null }) }),
    insert: async (t: string, doc: any) => { const _id = `${t}-${tables[t]!.length}`; tables[t]!.push({ _id, ...doc }); return _id; },
    system: { get: async (id: string) => blobs[id] ?? null },
  };
  const ctx: any = { db, storage: { getUrl: vi.fn(async (id: string) => `https://storage.test/${id}`), delete: vi.fn() } };
  return { ctx, tables };
}
const call = (f: any, ctx: any, args: any) => f._handler(ctx, args);
const show = (storageId: string, caption = "Mesh near the leading edge") => ({ token: "t", runId: "run", storageId, name: `${storageId}.png`, caption });

it("records a run's pictures in order and lists them with their URLs", async () => {
  const { ctx } = fixture();
  await call(add, ctx, show("png"));
  await call(add, ctx, show("svg", "Residuals of the trial run"));
  expect(await call(forRun, ctx, { runId: "run" })).toMatchObject([
    { name: "png.png", caption: "Mesh near the leading edge", url: "https://storage.test/png" },
    { caption: "Residuals of the trial run", url: "https://storage.test/svg" },
  ]);
});

it("refuses anything but a small image, and deletes the refused upload", async () => {
  const { ctx, tables } = fixture();
  await expect(call(add, ctx, show("exe"))).rejects.toThrow("PNG, JPEG, GIF, WebP or SVG");
  await expect(call(add, ctx, show("big"))).rejects.toThrow("10 MB or less");
  expect(ctx.storage.delete.mock.calls.map((c: string[]) => c[0])).toEqual(["exe", "big"]);
  expect(tables.machineShows).toEqual([]);
  await expect(call(add, ctx, { ...show("png"), token: "nope" })).rejects.toThrow("Invalid runner token");
});

it("caps pictures per run and never records one upload twice", async () => {
  const { ctx, tables } = fixture();
  await call(add, ctx, show("png"));
  await expect(call(add, ctx, show("png"))).rejects.toThrow("already shown");
  tables.machineShows = Array.from({ length: 24 }, (_, i) => ({ _id: `s${i}`, runId: "run", storageId: `b${i}` }));
  await expect(call(add, ctx, show("svg"))).rejects.toThrow("at most 24");
});

it("shows a run's pictures only to people who can read its chat", async () => {
  const { ctx, tables } = fixture();
  tables.members = [];
  await expect(call(forRun, ctx, { runId: "run" })).rejects.toThrow();
});
