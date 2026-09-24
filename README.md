# Beam

A Supraluminal Intelligence desktop app where a team and their coding agents share one chat. Argue it out, then beam it.

- Design doc: https://claude.ai/code/artifact/68a1818d-97fe-4230-9fbc-a87830232698
- Prototype: https://claude.ai/code/artifact/b7eb2f9a-8fe7-4f8a-9daa-bcd66dc9aa2c
- Build plan: https://claude.ai/code/artifact/23861a5a-e745-461a-a052-a6c60afc2107

## Layout

| path | role |
|---|---|
| `apps/desktop` | Electron main + preload. Spawns the runner, loads `apps/web`. |
| `apps/web` | React UI. Never assumes Electron. |
| `apps/runner` | `beam-runner` CLI. A Convex client that hosts runs on this machine. |
| `packages/contracts` | zod schemas shared by everything. |
| `packages/harness` | Adapter interface plus Claude Code, Codex, and omp adapters and probes. |
| `packages/git` | Mirrors, worktrees, checkpoints, commit → push → PR. |
| `packages/reducer` | Pure fold of run events into a chat view. |
| `convex/` | Shared plane: schema, auth, queries, mutations. |

## Run

```
pnpm install
pnpm convex          # convex dev against the prod deployment (cautious-fish-858), watches convex/
pnpm convex:deploy   # one-shot push
pnpm dev:web         # UI at http://localhost:5173
pnpm dev:runner      # runner on this machine
pnpm dev:desktop     # Electron shell (after dev:web)
pnpm probe           # what harnesses this machine has and whether they are signed in
```

Convex project `beam-backend`, one deployment, production, used for dev and deploy alike. `.env.local` carries `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL`.

## Principles

Chat is the record. Agents speak only when spoken to. Git is the shared filesystem. Nobody owns an agent. A run always ends with a push. Beam never holds a provider credential.

## Codex

Install Codex CLI 0.151 or newer on the runner's machine and sign in with `codex login`.
GPT-6 Astra is available in both model pickers; use CLI 0.155.1 or newer for Astra.
Refresh Connected harnesses, then mention `@codex` in a chat (or pin it in a private chat).
Restart a running development runner after updating this checkout.

The adapter uses the user's `codex app-server` over stdio. It supports streamed replies and
tool activity, Beam's repo/PR tools, approvals and questions answered in chat, interruption,
and persisted thread resume on the same machine. Mid-run messages queue as separate turns,
matching Beam's runner and Claude adapter. Model labels resolve against the CLI's model catalog;
`max` selects the highest supported effort when the model does not expose that exact level.

Auto mode gives both harnesses full access without tool approval prompts: Codex uses
`never` approvals with `danger-full-access`; Claude uses `bypassPermissions`. Any tool
approval requests that still reach the adapters are accepted without opening Allow/Deny
controls. Genuine questions still ask for an answer. Settings apply when a run starts,
including when it resumes a previous session.

In Codex ask mode, a workspace-write sandbox routes untrusted operations to Beam.
Allow-list mode automatically accepts matching command requests and edits; broader access
still requires approval. Plan mode stays read-only until someone approves the plan in chat.
Existing provider rules and administrator constraints still apply.
MCP forms/browser elicitations are declined with an explanation; secret inputs belong in the CLI.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).
Adapter tests use an in-memory protocol peer; transport tests use local child processes and
do not require a provider login. Live verification was performed with Codex CLI 0.151.0
and with GPT-6 Astra on CLI 0.155.1.

Reply text is saved in segments at tool and steer boundaries. The chat interleaves these
segments, human messages, and tool rows chronologically; tool completions update their
existing rows. Earlier runs retain their stored text because their original paragraph
timing was not recorded. Restart the runner to enable segmentation for new runs.

## Personal agent settings and routing experiments

See [account/machine selection and shared-workspace decision matrix](docs/decisions/2026-09-23-agent-connections.md) and [implementation, validation, and rollout](docs/agent-connections-plan.md) for current account routing, isolated profiles, concurrent agents, and shared resources.

See [personal defaults, account attribution, and the Jev benchmark](docs/personal-agents-and-jev.md) for behavior, validation results and rollout instructions.

See [notifications and typing](docs/notifications-and-typing.md) for completion alerts, followed chats, background behavior and live typing status.

See [tools, browser, and local compute](docs/compute-and-tools.md) for the Engineering pane, durable job lifecycle, T3 Code reuse, and the future remote/HPC executor boundary.

See [CAD Viewer](docs/cad-viewer.md) for local model inspection, supported formats, artifact integration, and the CAD/CFD extension boundary.
