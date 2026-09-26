# Working in this repo

Read README.md first, then the build plan link in it. The design decisions there are settled; do not re-litigate them in code.

## Rules
- Plain TypeScript. No Effect. zod at the boundaries, pure functions inside.
- `apps/web` must never import Electron or Node. It talks to Convex and, optionally, to `window.beam` (the preload bridge), which may be undefined.
- Only `apps/runner` and `packages/harness` and `packages/git` touch the filesystem, child processes, or git.
- Beam never stores a provider credential. Adapters spawn the user's own CLI with the user's own config and probe for state.
- Every harness event is normalized to `RunEvent` in `packages/contracts` before it leaves the adapter.
- Content deltas are coalesced (100ms) before they are written to Convex.
- A run always ends with a push, including on interrupt or failure.
- Commit messages: imperative mood, no AI attribution footers.
- To run the app from a worktree, use `pnpm dev:isolated`, not `dev:web`/`dev:desktop`. Other checkouts may already be using port 5173 and the runner (CONTRIBUTING.md, "Several checkouts at once"). Never deploy `convex/` just to try a change.

## Reference
`~/Developer/t3code` is a read-only reference (MIT). Borrow ideas, not code, except for pieces explicitly noted in the plan; keep the MIT notice with any copied file.
