import { v } from "convex/values";
import { requireLayer, v1Mutation, v1Query } from "../layers";
import { inboxFor } from "../notifications";
import { notification } from "./shape";

export const list = v1Query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { login } = await requireLayer(ctx, token);
    return (await inboxFor(ctx, login)).map(notification);
  },
});
