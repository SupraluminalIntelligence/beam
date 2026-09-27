import { v } from "convex/values";
import { requireLayer, v1Mutation, v1Query } from "../layers";
import { person } from "./shape";
import type { Scope } from "../../packages/contracts/src/layer";

/** Who this token acts for, and what it may do. The first call every layer makes. */
export const get = v1Query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { token: t, login } = await requireLayer(ctx, token);
    return { ...(await person(ctx, login)), layer: { name: t.name, scopes: t.scopes as Scope[] } };
  },
});

/** A layer signing out ends its own token. It can never touch anyone else's. */
export const revoke = v1Mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { token: t } = await requireLayer(ctx, token);
    await ctx.db.patch(t._id, { revokedAt: Date.now() });
  },
});
