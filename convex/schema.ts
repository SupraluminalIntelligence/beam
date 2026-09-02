import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    githubToken: v.optional(v.string()),   // OAuth token from sign-in (repo scope); only read by github.ts actions, never returned to clients
    githubTokenScope: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    githubLogin: v.optional(v.string()),
  }).index("email", ["email"]).index("by_login", ["githubLogin"]),

  workspaces: defineTable({ name: v.string(), repos: v.array(v.string()), createdBy: v.id("users") }),
  /** Membership is by GitHub login so an invite can precede the person's first sign-in. */
  members: defineTable({ workspaceId: v.id("workspaces"), githubLogin: v.string(), invitedBy: v.id("users") })
    .index("by_workspace", ["workspaceId"]).index("by_login", ["githubLogin"]),
  agents: defineTable({
    workspaceId: v.id("workspaces"), harness: v.string(), handle: v.string(), model: v.string(), effort: v.string(),
    permissionMode: v.string(), alwaysAllow: v.array(v.string()), contextPolicy: v.string(),
  }).index("by_workspace", ["workspaceId"]),
  /** A runner's long-lived credential. Only the hash is stored. One per machine per person. */
  runnerTokens: defineTable({ tokenHash: v.string(), githubLogin: v.string(), name: v.string(), createdAt: v.number(), revokedAt: v.union(v.number(), v.null()) })
    .index("by_hash", ["tokenHash"]).index("by_login", ["githubLogin"]),
  /** Device-code login in flight. Deleted once polled after approval. */
  deviceCodes: defineTable({ deviceCode: v.string(), userCode: v.string(), kind: v.optional(v.string()), name: v.string(), hostname: v.string(), status: v.string(), expiresAt: v.number(), token: v.union(v.string(), v.null()), githubLogin: v.union(v.string(), v.null()), userId: v.optional(v.id("users")) })
    .index("by_device", ["deviceCode"]).index("by_user_code", ["userCode"]),
  /** A machine that can host runs. Belongs to a person, available in every workspace they are a member of. */
  runners: defineTable({
    tokenId: v.id("runnerTokens"), ownerLogin: v.string(), name: v.string(), hostname: v.string(), platform: v.string(),
    online: v.boolean(), lastSeen: v.number(), harnesses: v.any(), probeRequestedAt: v.number(), launchedByApp: v.boolean(),
  }).index("by_token", ["tokenId"]).index("by_owner", ["ownerLogin"]),
  chats: defineTable({
    workspaceId: v.id("workspaces"), title: v.string(), untitled: v.boolean(), private: v.boolean(),
    members: v.array(v.string()), // github logins
    agents: v.union(v.array(v.id("agents")), v.null()),
    pinnedAgent: v.union(v.id("agents"), v.null()), pinnedRunner: v.union(v.id("runners"), v.null()),
    repo: v.union(v.string(), v.null()), activeBranch: v.union(v.string(), v.null()),
    createdBy: v.string(), lastMessageAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
  messages: defineTable({
    chatId: v.id("chats"),
    author: v.string(),        // github login, or "agent:<agentId>"
    kind: v.string(),          // text | dispatch | steer | ask | report
    text: v.string(),
    runId: v.union(v.id("runs"), v.null()),
    turn: v.optional(v.number()),   // agent messages: which turn of the run produced this text
    reactions: v.array(v.object({ emoji: v.string(), by: v.array(v.string()) })),
  }).index("by_chat", ["chatId"]),
  runs: defineTable({
    chatId: v.id("chats"), agentId: v.id("agents"), runnerId: v.id("runners"), dispatchedBy: v.string(),
    dispatchMessageId: v.id("messages"), state: v.string(),
    branch: v.union(v.string(), v.null()), worktree: v.union(v.string(), v.null()), resumeCursor: v.any(),
    landing: v.any(), startedAt: v.union(v.number(), v.null()), endedAt: v.union(v.number(), v.null()),
    interruptRequestedAt: v.optional(v.number()),
  }).index("by_chat", ["chatId"]).index("by_runner_state", ["runnerId", "state"]),
  runEvents: defineTable({ runId: v.id("runs"), seq: v.number(), event: v.any() }).index("by_run", ["runId", "seq"]),
  presence: defineTable({ workspaceId: v.id("workspaces"), githubLogin: v.string(), focusedChat: v.union(v.id("chats"), v.null()), updatedAt: v.number() })
    .index("by_workspace", ["workspaceId"]).index("by_login", ["githubLogin"]),
});
