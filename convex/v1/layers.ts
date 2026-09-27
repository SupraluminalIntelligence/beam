import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireLayer } from "../layers";
import { requireMemberLogin } from "../lib";
import { readableChat } from "./shape";
import { LAYER_ID, LAYER_STATE_MAX_BYTES } from "../../packages/contracts/src/layer";

/**
 * A layer's own state: where someone stands in a 3D office, a kanban's column order, a garden's layout. The
 * engine never reads it. People write only their own entry; chat and workspace entries are shared, and anyone
 * who can see the chat or workspace may write them, as they could rename it.
 */

const MIN_INTERVAL = 100; // one entry at most ten writes a second; the SDK sends about four

function checkLayer(layer: string) {
  if (!LAYER_ID.test(layer)) throw new Error("a layer id is lowercase letters, digits and dashes, up to 40");
}

async function access(ctx: QueryCtx | MutationCtx, token: string, workspaceId: Id<"workspaces">, scope: "read" | "layer:state") {
  const { login } = await requireLayer(ctx, token, scope);
  await requireMemberLogin(ctx, workspaceId, login);
  return login;
}

export const state = query({
  args: { token: v.string(), workspaceId: v.id("workspaces"), layer: v.string() },
  handler: async (ctx, { token, workspaceId, layer }) => {
    const login = await access(ctx, token, workspaceId, "read");
    checkLayer(layer);
    const rows = await ctx.db.query("layerState").withIndex("by_layer", (q) => q.eq("workspaceId", workspaceId).eq("layer", layer)).collect();
    const members = new Set((await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).map((m) => m.githubLogin));
    const chats = [];
    for (const r of rows.filter((r) => r.scope === "chat" && r.chatId)) {
      const c = await ctx.db.get(r.chatId!);
      if (c && c.state !== "deleted" && (!c.private || c.members.includes(login))) chats.push({ chatId: r.chatId!, data: r.data, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
    }
    const ws = rows.find((r) => r.scope === "workspace");
    return {
      layer,
      people: rows.filter((r) => r.scope === "person" && r.login && members.has(r.login)).map((r) => ({ login: r.login!, data: r.data, updatedAt: r.updatedAt })),
      chats,
      workspace: ws ? { data: ws.data, updatedBy: ws.updatedBy, updatedAt: ws.updatedAt } : null,
    };
  },
});

export const set = mutation({
  args: { token: v.string(), workspaceId: v.id("workspaces"), layer: v.string(), scope: v.string(), chatId: v.optional(v.union(v.id("chats"), v.null())), data: v.any() },
  handler: async (ctx, { token, workspaceId, layer, scope, chatId, data }) => {
    const login = await access(ctx, token, workspaceId, "layer:state");
    checkLayer(layer);
    if (scope !== "person" && scope !== "chat" && scope !== "workspace") throw new Error('scope is "person", "chat" or "workspace"');
    if (scope === "chat") {
      if (!chatId) throw new Error("chat state needs a chatId");
      if ((await readableChat(ctx, chatId, login)).workspaceId !== workspaceId) throw new Error("that chat is in another workspace");
    } else if (chatId) throw new Error(`${scope} state takes no chatId`);
    const bytes = data === undefined ? 0 : new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes > LAYER_STATE_MAX_BYTES) throw new Error(`layer state is at most ${LAYER_STATE_MAX_BYTES} bytes; this is ${bytes}`);
    const key = { chatId: scope === "chat" ? chatId! : null, login: scope === "person" ? login : null };
    const row = await ctx.db.query("layerState").withIndex("by_key", (q) => q.eq("workspaceId", workspaceId).eq("layer", layer).eq("scope", scope).eq("chatId", key.chatId).eq("login", key.login)).first();
    const now = Date.now();
    if (data === null || data === undefined) { if (row) await ctx.db.delete(row._id); return null; }
    if (row && now - row.updatedAt < MIN_INTERVAL) throw new Error("too many writes; send layer state at most a few times a second");
    if (row) await ctx.db.patch(row._id, { data, updatedBy: login, updatedAt: now });
    else await ctx.db.insert("layerState", { workspaceId, layer, scope, ...key, data, updatedBy: login, updatedAt: now });
    return null;
  },
});
