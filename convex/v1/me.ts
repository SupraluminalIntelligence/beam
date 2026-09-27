import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireLayer } from "../layers";
import { person } from "./shape";
import type { Scope } from "../../packages/contracts/src/layer";

/** Who this token acts for, and what it may do. The first call every layer makes. */
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { token: t, login } = await requireLayer(ctx, token);
    return { ...(await person(ctx, login)), layer: { name: t.name, scopes: t.scopes as Scope[] } };
  },
});

/** A layer signing out ends its own token. It can never touch anyone else's. */
export const revoke = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { token: t } = await requireLayer(ctx, token);
    await ctx.db.patch(t._id, { revokedAt: Date.now() });
  },
});
