import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    username: v.optional(v.string()),
    githubToken: v.optional(v.string()),   // OAuth token from sign-in (repo scope); only read by github.ts actions, never returned to clients
    githubTokenScope: v.optional(v.string()),
    githubRejectedTokenHash: v.optional(v.string()), // fingerprint of githubToken when GitHub answered 401; a match means dead until the next sign-in replaces it
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    githubLogin: v.optional(v.string()),
    notificationPreferences: v.optional(v.object({ enabled: v.boolean(), completed: v.boolean(), failed: v.boolean(), input: v.boolean(), mention: v.optional(v.boolean()), sound: v.boolean(), pausedUntil: v.optional(v.number()) })),
    resourceSharing: v.optional(v.union(v.literal("auto"), v.literal("ask"))),
    accountPreferences: v.optional(v.array(v.object({ harness: v.string(), runnerId: v.optional(v.id("runners")), connectionId: v.optional(v.string()) }))),
    // Where agents run when a run starts somewhere with no runner of its own: the phone, the CLI, a Beam World.
    awayPreferences: v.optional(v.array(v.object({ harness: v.string(), runnerId: v.id("runners"), connectionId: v.string() }))),
    chatConnections: v.optional(v.array(v.object({ chatId: v.id("chats"), harness: v.string(), runnerId: v.optional(v.id("runners")), connectionId: v.optional(v.string()) }))),
    agentPreferences: v.optional(v.array(v.object({ harness: v.string(), model: v.string(), effort: v.string(), runnerId: v.optional(v.id("runners")), connectionId: v.optional(v.string()) }))),
  }).index("email", ["email"]).index("by_login", ["githubLogin"]).index("by_username", ["username"]),

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
  /** A connected app's credential (Beam Worlds): reads, and scoped writes, as one person. Only the hash is stored. Named before the feature was. */
  layerTokens: defineTable({ tokenHash: v.string(), githubLogin: v.string(), name: v.string(), hostname: v.string(), scopes: v.array(v.string()), createdAt: v.number(), revokedAt: v.union(v.number(), v.null()) })
    .index("by_hash", ["tokenHash"]).index("by_login", ["githubLogin"]),
  /** Device-code login in flight. Deleted once polled after approval. kind: runner | desktop | layer (a Beam Worlds app); scopes are the app's request. */
  deviceCodes: defineTable({ deviceCode: v.string(), userCode: v.string(), kind: v.optional(v.string()), scopes: v.optional(v.array(v.string())), name: v.string(), hostname: v.string(), status: v.string(), expiresAt: v.number(), token: v.union(v.string(), v.null()), githubLogin: v.union(v.string(), v.null()), userId: v.optional(v.id("users")) })
    .index("by_device", ["deviceCode"]).index("by_user_code", ["userCode"]),
  /** A machine that can host runs. Belongs to a person, available in every workspace they are a member of. */
  runners: defineTable({
    tokenId: v.id("runnerTokens"), ownerLogin: v.string(), name: v.string(), hostname: v.string(), platform: v.string(),
    allowSharedRuns: v.optional(v.boolean()),
    displayName: v.optional(v.string()),
    computeBackend: v.optional(v.literal("local-process")),
    openfoam: v.optional(v.object({ready:v.boolean(),message:v.string(),image:v.string()})),
    online: v.boolean(), lastSeen: v.number(), harnesses: v.any(), probeRequestedAt: v.number(), launchedByApp: v.boolean(),
  }).index("by_token", ["tokenId"]).index("by_owner", ["ownerLogin"]),
  chats: defineTable({
    workspaceId: v.id("workspaces"), title: v.string(), untitled: v.boolean(), private: v.boolean(),
    members: v.array(v.string()), // github logins
    agents: v.union(v.array(v.id("agents")), v.null()),
    pinnedAgent: v.union(v.id("agents"), v.null()), pinnedRunner: v.union(v.id("runners"), v.null()),
    repo: v.union(v.string(), v.null()), activeBranch: v.union(v.string(), v.null()), // legacy single repo; `repos` is the truth
    repos: v.optional(v.array(v.string())),   // every repo this thread works in; one worktree each in the thread directory
    state: v.optional(v.string()),            // open | settled | deleted (default open)
    doneAt: v.optional(v.number()), settledAt: v.optional(v.number()),
    autoRoute: v.optional(v.boolean()),   // agents listen to plain messages (default on)
    createdBy: v.string(), lastMessageAt: v.number(),
    activeStudyId: v.optional(v.union(v.id("simulationCases"),v.null())),
  }).index("by_workspace", ["workspaceId"]),
  files: defineTable({
    chatId: v.id("chats"), storageId: v.id("_storage"), name: v.string(), mime: v.string(), size: v.number(),
    author: v.string(), source: v.union(v.literal("uploaded"), v.literal("agent")),
    messageId: v.union(v.id("messages"), v.null()), text: v.optional(v.string()),
  }).index("by_chat", ["chatId"]).index("by_storage", ["storageId"]),
  contextSources: defineTable({
    workspaceId: v.id("workspaces"), originChatId: v.id("chats"), author: v.string(),
    kind: v.union(v.literal("file"), v.literal("link"), v.literal("note")),
    title: v.string(), fileId: v.optional(v.id("files")), url: v.optional(v.string()), content: v.optional(v.string()),
    shared: v.boolean(),
  }).index("by_workspace_shared", ["workspaceId", "shared"]).index("by_file", ["fileId"]),
  chatContext: defineTable({ chatId: v.id("chats"), sourceId: v.id("contextSources"), addedBy: v.string() })
    .index("by_chat", ["chatId"]).index("by_chat_source", ["chatId", "sourceId"]),
  messages: defineTable({
    chatId: v.id("chats"),
    localRunnerId: v.optional(v.id("runners")),
    author: v.string(),        // github login, or "agent:<agentId>"
    kind: v.string(),          // text | dispatch | steer | ask | report
    text: v.string(),
    runId: v.union(v.id("runs"), v.null()),
    turn: v.optional(v.number()),   // agent messages: which turn of the run produced this text
    routed: v.optional(v.union(v.null(), v.object({ agent: v.union(v.string(), v.null()), why: v.string(), error: v.optional(v.string()) }))), // the router's decision for a plain message
    attachments: v.optional(v.array(v.id("files"))),
    computeJobId: v.optional(v.id("computeJobs")),
    simulationStudyId: v.optional(v.id("simulationCases")),
    /** A files simulation's card. Recipe cards use simulationStudyId, which installed apps draw as a study card. */
    simulationId: v.optional(v.id("simulationCases")),
    studyContext: v.optional(v.union(v.object({id:v.id("simulationCases"),revision:v.number(),name:v.string()}),v.null())),
    reactions: v.array(v.object({ emoji: v.string(), by: v.array(v.string()) })),
  }).index("by_chat", ["chatId"]),
  runs: defineTable({
    chatId: v.id("chats"), agentId: v.id("agents"), runnerId: v.id("runners"), dispatchedBy: v.string(),
    workScope: v.optional(v.string()),
    dispatchMessageId: v.id("messages"), state: v.string(),
    studyId: v.optional(v.union(v.id("simulationCases"),v.null())),
    branch: v.union(v.string(), v.null()), worktree: v.union(v.string(), v.null()), resumeCursor: v.any(),
    landing: v.any(), startedAt: v.union(v.number(), v.null()), endedAt: v.union(v.number(), v.null()),
    execution: v.optional(v.object({ model: v.string(), modelName: v.optional(v.string()), effort: v.string(), accountOwner: v.string(), accountEmail: v.union(v.string(), v.null()), accountPlan: v.union(v.string(), v.null()), connectionId: v.optional(v.string()), connectionName: v.optional(v.string()), machineName: v.optional(v.string()), accountIdentity: v.optional(v.string()) })),
    interruptRequestedAt: v.optional(v.number()),
    openRequests: v.optional(v.array(v.string())), // approval/input requests the agent is waiting on; drives the chat's "needs you" status
  }).index("by_chat", ["chatId"]).index("by_chat_state", ["chatId", "state"]).index("by_runner_state", ["runnerId", "state"]).index("by_state", ["state"]),
  /** A change is one branch in one repo with its PR. A thread holds many, across repos and over time. */
  changes: defineTable({
    chatId: v.id("chats"), workspaceId: v.id("workspaces"), repo: v.string(), branch: v.string(), base: v.string(),
    state: v.string(),                       // open | merged | closed
    title: v.string(), prUrl: v.union(v.string(), v.null()), prNumber: v.union(v.number(), v.null()),
    body: v.optional(v.string()),            // the agent's PR description, for a PR opened later with Create PR
    add: v.number(), del: v.number(), files: v.number(),
    workScope: v.optional(v.string()),
    adopted: v.boolean(),                    // came from an existing PR rather than a run
    createdBy: v.string(), updatedAt: v.number(), resolvedAt: v.union(v.number(), v.null()),
    // Read back from GitHub by github.ts; absent until the first sync of a PR.
    draft: v.optional(v.boolean()), headSha: v.optional(v.string()),
    checks: v.optional(v.object({
      state: v.union(v.literal("pending"), v.literal("passing"), v.literal("failing"), v.literal("none")),
      passed: v.number(), failed: v.number(), pending: v.number(), skipped: v.number(),
      items: v.array(v.object({ name: v.string(), state: v.union(v.literal("passed"), v.literal("failed"), v.literal("pending"), v.literal("skipped")), url: v.union(v.string(), v.null()) })),
      checkedAt: v.number(),
    })),
    syncError: v.optional(v.string()),     // why the last GitHub read failed; cleared by the next good one
    syncGen: v.optional(v.number()),         // bumped to start a fresh poll; an older poll sees the new number and stops
    author: v.optional(v.string()), openedAt: v.optional(v.number()),   // who opened the PR on GitHub, and when
    headAt: v.optional(v.number()),          // when a sync first saw the current head; auto-merge gives CI time to register
    comments: v.optional(v.array(v.object({ id: v.string(), path: v.union(v.string(), v.null()), line: v.union(v.number(), v.null()), author: v.union(v.string(), v.null()), body: v.string(), url: v.union(v.string(), v.null()) }))), // unresolved review comments
    // Per-PR automation, each switched on by one person and acting as them. Absent means off.
    autoFix: v.optional(v.object({ by: v.string(), agentId: v.id("agents"), attempts: v.number(), sha: v.optional(v.string()), addressed: v.array(v.string()), note: v.optional(v.string()) })),
    autoMerge: v.optional(v.object({ by: v.string(), note: v.optional(v.string()) })),
    autoSettle: v.optional(v.object({ by: v.string() })),
  }).index("by_chat", ["chatId"]).index("by_state", ["state"]),
  runEvents: defineTable({ runId: v.id("runs"), seq: v.number(), event: v.any() }).index("by_run", ["runId", "seq"]),
  /** Jobs are independent of agent runs. Never reap them when an agent or runner disconnects. */
  /** Simulations (packages/contracts/src/simulations.ts). kind absent = recipe: the studies that came first. A files simulation has config null. */
  simulationCases: defineTable({chatId:v.id("chats"),name:v.string(),config:v.any(),revision:v.number(),updatedAt:v.number(),updatedBy:v.string(),cardMessageId:v.optional(v.id("messages")),kind:v.optional(v.union(v.literal("recipe"),v.literal("files"))),workspaceId:v.optional(v.id("workspaces")),draft:v.optional(v.boolean())}).index("by_chat",["chatId"]),
  /** What Beam reads from a simulation's work on the chat's machine while the agent works: the latest LiveView (packages/contracts/src/live.ts). */
  /** What the runner reads as work happens: an agent's work on the chat's machine (one per simulation), or a running job (one per job). */
  liveViews: defineTable({simulationId:v.id("simulationCases"),chatId:v.id("chats"),source:v.union(v.literal("machine"),v.literal("job")),jobId:v.optional(v.id("computeJobs")),view:v.any(),updatedAt:v.number()}).index("by_simulation",["simulationId"]).index("by_job",["jobId"]).index("by_chat",["chatId"]),
  /** Versions. A files version has config null and its FilesSetup in setup. */
  simulationRevisions: defineTable({studyId:v.id("simulationCases"),revision:v.number(),name:v.string(),config:v.any(),createdAt:v.number(),createdBy:v.string(),setup:v.optional(v.any()),note:v.optional(v.string()),from:v.optional(v.number())}).index("by_study_revision",["studyId","revision"]),
  computeJobs: defineTable({
    /** Cloud jobs keep the runner they were submitted from; the gateway, not that runner, runs them. */
    chatId: v.id("chats"), runnerId: v.id("runners"), backend: v.union(v.literal("local-process"), v.literal("modal-sandbox")),
    requestedBy: v.string(), sourceRunId: v.optional(v.id("runs")), requestKey: v.string(),
    spec: v.any(), state: v.union(...["awaiting-approval", "queued", "preparing", "running", "publishing", "succeeded", "failed", "cancelled"].map(s => v.literal(s))),
    createdAt: v.number(), updatedAt: v.number(), startedAt: v.optional(v.number()), endedAt: v.optional(v.number()),
    cancelRequestedAt: v.optional(v.number()), approvedBy: v.optional(v.string()),
    handle: v.optional(v.object({ backend: v.string(), id: v.string() })),
    log: v.string(), error: v.union(v.string(), v.null()), exitCode: v.optional(v.union(v.number(), v.null())),
    outputs: v.array(v.id("computeAssets")),
    /** The simulation the job belongs to. Every job since live jobs has one; a study's job (the recipe in its spec) has none. */
    simulationId: v.optional(v.id("simulationCases")),
    /** Environment jobs: the ResultsManifest (packages/contracts/src/results.ts), or null when the job wrote none. */
    results: v.optional(v.object({ manifest: v.any(), unpublished: v.array(v.object({ path: v.string(), reason: v.string() })) })),
    /** Cloud jobs: the machine's rate, the most approval authorized, and what was metered from when the machine was created. Reserved while the job may still spend. */
    billing: v.optional(v.object({ centsPerHour: v.number(), authorizedCents: v.number(), spentCents: v.number(), reserved: v.boolean(), meteredFrom: v.optional(v.number()) })),
    /** A finished cloud job whose machine the gateway has not yet confirmed stopped. Its spend settles then. */
    awaitingRelease: v.optional(v.boolean()),
    /** Cloud jobs: when the gateway last began launching a machine, and first began releasing it, recorded before each call to the provider. */
    launchedAt: v.optional(v.number()),
    releasingAt: v.optional(v.number()),
  }).index("by_chat", ["chatId"]).index("by_chat_state", ["chatId", "state"]).index("by_request", ["chatId", "requestedBy", "requestKey"]).index("by_runner_state", ["runnerId", "state"]).index("by_backend_state", ["backend", "state"]).index("by_backend_release", ["backend", "awaitingRelease"]),
  /** A workspace's cloud compute allowance. Reservations hold each approved job's authorized amount until it settles. */
  computeBudgets: defineTable({ workspaceId: v.id("workspaces"), allowanceCents: v.number(), reservedCents: v.number(), spentCents: v.number(), updatedAt: v.number(), updatedBy: v.string() }).index("by_workspace", ["workspaceId"]),
  computeAssets: defineTable({
    chatId: v.id("chats"), storageId: v.id("_storage"), path: v.string(), size: v.number(), sha256: v.string(),
    author: v.string(), jobId: v.optional(v.id("computeJobs")),
  }).index("by_storage", ["storageId"]).index("by_job", ["jobId"]),
  // A job's outputs over the Convex storage limit, kept in the object store (R2) under `key`. Separate from
  // computeAssets, whose storageId every reader relies on; size and sha256 are what the uploader measured.
  computeObjects: defineTable({
    chatId: v.id("chats"), jobId: v.id("computeJobs"), path: v.string(), key: v.string(), size: v.number(), sha256: v.string(),
    author: v.string(), createdAt: v.number(),
  }).index("by_job", ["jobId", "path"]),
  workspaceResources: defineTable({ workspaceId: v.id("workspaces"), chatId: v.id("chats"), runnerId: v.id("runners"), owner: v.string(), localId: v.string(), name: v.string(), kind: v.union(v.literal("folder"), v.literal("service")), shared: v.boolean(), allowInstall: v.boolean(), revoked: v.boolean() }).index("by_workspace", ["workspaceId"]).index("by_runner", ["runnerId"]),
  resourceRequests: defineTable({ resourceId: v.id("workspaceResources"), runnerId: v.id("runners"), requesterRunnerId: v.id("runners"), requestedBy: v.string(), chatId: v.id("chats"), sourceRunId: v.optional(v.id("runs")), operation: v.any(), state: v.string(), createdAt: v.number(), result: v.optional(v.string()), error: v.optional(v.string()) }).index("by_runner_state", ["runnerId", "state"]),
  typing: defineTable({ chatId: v.id("chats"), login: v.string(), session: v.string(), expiresAt: v.number() })
    .index("by_chat", ["chatId"]).index("by_session", ["chatId", "login", "session"]),
  chatFollowers: defineTable({ chatId: v.id("chats"), login: v.string(), muted: v.optional(v.boolean()) }).index("by_chat", ["chatId"]),
  notifications: defineTable({ recipient: v.string(), key: v.string(), chatId: v.id("chats"), workspaceId: v.id("workspaces"), runId: v.optional(v.id("runs")), messageId: v.optional(v.id("messages")), deliveryToken: v.optional(v.string()), deliveryExpiresAt: v.optional(v.number()), kind: v.union(v.literal("completed"), v.literal("failed"), v.literal("input"), v.literal("mention")), title: v.string(), body: v.string(), readAt: v.union(v.number(), v.null()), deliveredAt: v.union(v.number(), v.null()) })
    .index("by_recipient", ["recipient"]).index("by_key", ["recipient", "key"]).index("by_run", ["runId"]),
  presence: defineTable({ workspaceId: v.id("workspaces"), githubLogin: v.string(), focusedChat: v.union(v.id("chats"), v.null()), updatedAt: v.number(), world: v.optional(v.string()) }) // world: the interface they focused from, absent for the plain apps
    .index("by_workspace", ["workspaceId"]).index("by_login", ["githubLogin"]),
  /**
   * Free-form state a world keeps: a position, a pose, a layout. Namespaced by world id and never
   * read by the engine. person: one per person (only they write it) · chat: one per chat · workspace: one per workspace.
   */
  worldState: defineTable({
    workspaceId: v.id("workspaces"), world: v.string(), scope: v.union(v.literal("person"), v.literal("chat"), v.literal("workspace")),
    chatId: v.union(v.id("chats"), v.null()), login: v.union(v.string(), v.null()), data: v.any(), updatedBy: v.string(), updatedAt: v.number(),
  }).index("by_world", ["workspaceId", "world"]).index("by_key", ["workspaceId", "world", "scope", "chatId", "login"]),
  /** Phones that receive push. An Expo push token per install; a token moves to whoever signs in on that phone last. */
  pushTokens: defineTable({ login: v.string(), token: v.string(), platform: v.string(), deviceName: v.union(v.string(), v.null()), updatedAt: v.number() })
    .index("by_login", ["login"]).index("by_token", ["token"]),
});
