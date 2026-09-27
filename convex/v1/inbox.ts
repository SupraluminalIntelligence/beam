import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireLayer } from "../layers";
import { inboxFor } from "../notifications";
import { notification } from "./shape";

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { login } = await requireLayer(ctx, token);
    return (await inboxFor(ctx, login)).map(notification);
  },
});
