import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  workspaces: defineTable({ name: v.string(), repos: v.array(v.string()), createdBy: v.string() }),
  members: defineTable({ workspaceId: v.id("workspaces"), userId: v.string(), githubLogin: v.string(), name: v.string() })
    .index("by_workspace", ["workspaceId"]).index("by_user", ["userId"]),
  agents: defineTable({
    workspaceId: v.id("workspaces"), harness: v.string(), handle: v.string(), model: v.string(), effort: v.string(),
    permissionMode: v.string(), alwaysAllow: v.array(v.string()), contextPolicy: v.string(),
  }).index("by_workspace", ["workspaceId"]),
  runners: defineTable({
    workspaceId: v.id("workspaces"), ownerId: v.string(), name: v.string(), online: v.boolean(), lastSeen: v.number(),
    harnesses: v.array(v.object({ harness: v.string(), installed: v.boolean(), auth: v.string(), plan: v.union(v.string(), v.null()), email: v.union(v.string(), v.null()), version: v.union(v.string(), v.null()) })),
  }).index("by_workspace", ["workspaceId"]),
  chats: defineTable({
    workspaceId: v.id("workspaces"), title: v.string(), untitled: v.boolean(), private: v.boolean(),
    members: v.array(v.string()), agents: v.union(v.array(v.id("agents")), v.null()),
    pinnedAgent: v.union(v.id("agents"), v.null()), pinnedRunner: v.union(v.id("runners"), v.null()),
    repo: v.union(v.string(), v.null()), activeBranch: v.union(v.string(), v.null()),
  }).index("by_workspace", ["workspaceId"]),
  messages: defineTable({
    chatId: v.id("chats"), author: v.string(), kind: v.string(), text: v.string(),
    runId: v.union(v.id("runs"), v.null()),
    reactions: v.array(v.object({ emoji: v.string(), by: v.array(v.string()) })),
  }).index("by_chat", ["chatId"]),
  runs: defineTable({
    chatId: v.id("chats"), agentId: v.id("agents"), runnerId: v.id("runners"), dispatchedBy: v.string(),
    dispatchMessageId: v.id("messages"), state: v.string(),
    branch: v.union(v.string(), v.null()), worktree: v.union(v.string(), v.null()), resumeCursor: v.any(),
    landing: v.union(v.object({ prNumber: v.union(v.number(), v.null()), prUrl: v.union(v.string(), v.null()), add: v.number(), del: v.number(), files: v.number() }), v.null()),
    startedAt: v.union(v.number(), v.null()), endedAt: v.union(v.number(), v.null()),
  }).index("by_chat", ["chatId"]).index("by_runner_state", ["runnerId", "state"]),
  runEvents: defineTable({ runId: v.id("runs"), seq: v.number(), event: v.any() }).index("by_run", ["runId", "seq"]),
  presence: defineTable({ workspaceId: v.id("workspaces"), userId: v.string(), focusedChat: v.union(v.id("chats"), v.null()), updatedAt: v.number() })
    .index("by_workspace", ["workspaceId"]).index("by_user", ["userId"]),
});
