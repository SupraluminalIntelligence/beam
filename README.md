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
