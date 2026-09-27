import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireApp, v1Mutation, v1Query } from "../layers";
import { requireMemberLogin } from "../lib";
import { readableChat } from "./shape";
import { WORLD_ID, WORLD_STATE_MAX_BYTES } from "../../packages/contracts/src/worlds";

/**
 * A world's own state: where someone stands in a 3D office, a kanban's column order, a garden's layout. The
 * engine never reads it. People write only their own entry; chat and workspace entries are shared, and anyone
 * who can see the chat or workspace may write them, as they could rename it.
 */

const MIN_INTERVAL = 100; // one entry at most ten writes a second; the SDK sends about four

function checkWorld(world: string) {
  if (!WORLD_ID.test(world)) throw new Error("a world id is lowercase letters, digits and dashes, up to 40");
}

async function access(ctx: QueryCtx | MutationCtx, token: string, workspaceId: Id<"workspaces">, scope: "read" | "world:state") {
  const { login } = await requireApp(ctx, token, scope);
  await requireMemberLogin(ctx, workspaceId, login);
  return login;
}

export const state = v1Query({
  args: { token: v.string(), workspaceId: v.id("workspaces"), world: v.string() },
  handler: async (ctx, { token, workspaceId, world }) => {
    const login = await access(ctx, token, workspaceId, "read");
    checkWorld(world);
    const rows = await ctx.db.query("worldState").withIndex("by_world", (q) => q.eq("workspaceId", workspaceId).eq("world", world)).collect();
    const members = new Set((await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).map((m) => m.githubLogin));
    const chats = [];
    for (const r of rows.filter((r) => r.scope === "chat" && r.chatId)) {
      const c = await ctx.db.get(r.chatId!);
      if (c && c.state !== "deleted" && (!c.private || c.members.includes(login))) chats.push({ chatId: r.chatId!, data: r.data, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
    }
    const ws = rows.find((r) => r.scope === "workspace");
    return {
      world,
      people: rows.filter((r) => r.scope === "person" && r.login && members.has(r.login)).map((r) => ({ login: r.login!, data: r.data, updatedAt: r.updatedAt })),
      chats,
      workspace: ws ? { data: ws.data, updatedBy: ws.updatedBy, updatedAt: ws.updatedAt } : null,
    };
  },
});

export const set = v1Mutation({
  args: { token: v.string(), workspaceId: v.id("workspaces"), world: v.string(), scope: v.string(), chatId: v.optional(v.union(v.id("chats"), v.null())), data: v.any() },
  handler: async (ctx, { token, workspaceId, world, scope, chatId, data }) => {
    const login = await access(ctx, token, workspaceId, "world:state");
    checkWorld(world);
    if (scope !== "person" && scope !== "chat" && scope !== "workspace") throw new Error('scope is "person", "chat" or "workspace"');
    if (scope === "chat") {
      if (!chatId) throw new Error("chat state needs a chatId");
      if ((await readableChat(ctx, chatId, login)).workspaceId !== workspaceId) throw new Error("that chat is in another workspace");
    } else if (chatId) throw new Error(`${scope} state takes no chatId`);
    const bytes = data === undefined ? 0 : new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes > WORLD_STATE_MAX_BYTES) throw new Error(`world state is at most ${WORLD_STATE_MAX_BYTES} bytes; this is ${bytes}`);
    const key = { chatId: scope === "chat" ? chatId! : null, login: scope === "person" ? login : null };
    const row = await ctx.db.query("worldState").withIndex("by_key", (q) => q.eq("workspaceId", workspaceId).eq("world", world).eq("scope", scope).eq("chatId", key.chatId).eq("login", key.login)).first();
    const now = Date.now();
    if (data === null || data === undefined) { if (row) await ctx.db.delete(row._id); return null; }
    if (row && now - row.updatedAt < MIN_INTERVAL) throw new Error("too many writes; send world state at most a few times a second");
    if (row) await ctx.db.patch(row._id, { data, updatedBy: login, updatedAt: now });
    else await ctx.db.insert("worldState", { workspaceId, world, scope, ...key, data, updatedBy: login, updatedAt: now });
    return null;
  },
});
