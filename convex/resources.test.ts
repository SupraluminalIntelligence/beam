import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: async () => "user" }));
vi.mock("./runners", () => ({ runnerForToken: async (ctx: any, token: string) => { const r = await ctx.db.get(token); if (!r) throw new Error("Invalid token"); return r; } }));
vi.mock("./runs", () => ({ ownRun: async (ctx: any, token: string, id: string) => { const run = await ctx.db.get(id); if (!run || run.runnerId !== token) throw new Error("Wrong runner"); return { run }; } }));
import { contribute, request, claim, lease, result, setAccess, expire } from "./resources";

function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: "user", githubLogin: "apex" }], members: ["apex", "noah"].map(githubLogin => ({ workspaceId: "workspace", githubLogin })),
    chats: [{ _id: "chat", workspaceId: "workspace", private: false, members: ["apex", "noah"] }],
    runners: [{ _id: "host", ownerLogin: "apex", online: true, lastSeen: Date.now() }, { _id: "requester", ownerLogin: "noah", online: true, lastSeen: Date.now() }],
    runs: [{ _id: "run", runnerId: "requester", chatId: "chat", dispatchedBy: "noah", state: "working", execution: { accountOwner: "noah" } }],
    workspaceResources: [], resourceRequests: [],
  };
  const db: any = {
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    patch: async (id: string, patch: any) => Object.assign(await db.get(id), patch),
    insert: async (table: string, value: any) => { const id = `${table}-${tables[table]!.length}`; tables[table]!.push({ _id: id, ...value }); return id; },
    query: (table: string) => ({ withIndex: (_: string, fn: any) => {
      const filters: [string, unknown][] = []; const q = { eq: (k: string, v: unknown) => { filters.push([k, v]); return q; } }; fn(q);
      const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => r[k] === v)); return { collect: async () => rows(), first: async () => rows()[0] ?? null };
    } }),
  };
  return { tables, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const add = { token: "host", chatId: "chat", localId: "local-folder", name: "Website", kind: "folder" };

it("automatically shares contributed workspace folders while retaining provider ownership", async () => {
  const { ctx, tables } = fixture(); const resourceId = await call(contribute, ctx, add);
  expect(tables.workspaceResources![0].shared).toBe(true);
  const id = await call(request, ctx, { token: "requester", runId: "run", resourceId, operation: { kind: "read", path: "index.html" } });
  expect(tables.resourceRequests![0]).toMatchObject({ runnerId: "host", requestedBy: "noah", requesterRunnerId: "requester" });
  expect(tables.runs![0].execution.accountOwner).toBe("noah");
  expect(await call(claim, ctx, { token: "host", id })).not.toBeNull();
  await call(setAccess, ctx, { id: resourceId, shared: false });
  expect(await call(lease, ctx, { token: "host", id })).toBe(false);
  await expect(call(result, ctx, { token: "requester", id })).rejects.toThrow("revoked");
});
it("honors explicit sharing mode and keeps private chat folders private", async () => {
  const { ctx, tables } = fixture(); tables.users![0].resourceSharing = "ask";
  const resourceId = await call(contribute, ctx, add);
  expect(tables.workspaceResources![0].shared).toBe(false);
  await expect(call(request, ctx, { token: "requester", runId: "run", resourceId, operation: { kind: "list" } })).rejects.toThrow("revoked");
  tables.users![0].resourceSharing = "auto"; tables.chats![0].private = true;
  await call(contribute, ctx, { ...add, localId: "other-folder" }); expect(tables.workspaceResources![1].shared).toBe(false);
});
it("requires installation consent and rechecks revocation and membership at execution", async () => {
  const { ctx, tables } = fixture(); const resourceId = await call(contribute, ctx, add);
  const command = { token: "requester", runId: "run", resourceId, operation: { kind: "command", command: "npm install", install: true } };
  await expect(call(request, ctx, command)).rejects.toThrow("enable dependency");
  await call(setAccess, ctx, { id: resourceId, allowInstall: true });
  const id = await call(request, ctx, command); tables.members = tables.members!.filter(m => m.githubLogin !== "noah");
  expect(await call(claim, ctx, { token: "host", id })).toBeNull();
  expect(tables.resourceRequests![0].state).toBe("failed");
  await call(expire, ctx, { id }); expect(tables.resourceRequests![0].operation).toEqual({ kind: "command" });
});
