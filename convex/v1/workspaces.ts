import { v } from "convex/values";
import { requireLayer, v1Mutation, v1Query } from "../layers";
import { requireMemberLogin } from "../lib";
import { agent, person } from "./shape";

export const list = v1Query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { login } = await requireLayer(ctx, token);
    const rows = await ctx.db.query("members").withIndex("by_login", (q) => q.eq("githubLogin", login)).collect();
    const ws = await Promise.all(rows.map((r) => ctx.db.get(r.workspaceId)));
    return ws.filter((w) => !!w).map((w) => ({ id: w._id, name: w.name, repos: w.repos }));
  },
});

export const get = v1Query({
  args: { token: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { token, workspaceId }) => {
    const { login } = await requireLayer(ctx, token);
    await requireMemberLogin(ctx, workspaceId, login);
    const w = await ctx.db.get(workspaceId);
    if (!w) throw new Error("no such workspace");
    const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    const agents = await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    return { id: w._id, name: w.name, repos: w.repos, members: await Promise.all(members.map((m) => person(ctx, m.githubLogin))), agents: agents.map(agent) };
  },
});
