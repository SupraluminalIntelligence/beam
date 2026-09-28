# Working in this repo

Read README.md first, then the build plan link in it. The design decisions there are settled; do not re-litigate them in code.

## Rules
- Plain TypeScript. No Effect. zod at the boundaries, pure functions inside.
- `apps/web` must never import Electron or Node. It talks to Convex and, optionally, to `window.beam` (the preload bridge), which may be undefined.
- Only `apps/runner` and `packages/harness` and `packages/git` touch the filesystem, child processes, or git. `apps/cli` may read and write its own token file (`~/.beam/layer.json`) and nothing else.
- The Beam Worlds API (`convex/v1/`, `packages/contracts/src/worlds.ts`) only grows: add fields, resources, actions and event types; never rename, remove or retype. Nothing private (paths, resume cursors, provider accounts) leaves `convex/v1/`. Every v1 write checks its scope, then calls the same helper as the plain app's mutation. See docs/worlds.md.
- Only `apps/gateway` calls cloud compute providers (Modal, later EC2) or reads Beam's cloud credentials (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`). Commands it runs execute inside provider sandboxes, never on the gateway's host.
- Beam never stores a provider credential. Adapters spawn the user's own CLI with the user's own config and probe for state.
- Functions the runner or a Beam World calls are `readableQuery`/`readableMutation` (convex/lib.ts): production hides a plain Error's message, and agents need the reason to act on it.
- Every harness event is normalized to `RunEvent` in `packages/contracts` before it leaves the adapter.
- Content deltas are coalesced (100ms) before they are written to Convex.
- A run always ends with a push, including on interrupt or failure.
- Commit messages: imperative mood, no AI attribution footers.
- To run the app from a worktree, use `pnpm dev:isolated`, not `dev:web`/`dev:desktop`. Other checkouts may already be using port 5173 and the runner (CONTRIBUTING.md, "Several checkouts at once"). Never deploy `convex/` just to try a change; backend changes go to a dev deployment first (docs/dev-backend.md, `node scripts/dev-backend.mjs`). Add `--takeover` when testing runner or desktop changes (CONTRIBUTING.md, "Testing a desktop change without a release").

## Reference
`~/Developer/t3code` is a read-only reference (MIT). Borrow ideas, not code, except for pieces explicitly noted in the plan; keep the MIT notice with any copied file.
