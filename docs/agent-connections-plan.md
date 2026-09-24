# Agent connections implementation plan

Written before implementation on 2026-09-23. Source decision: [complete decision and matrix](decisions/2026-09-23-agent-connections.md).

## Existing behavior and gaps

Current chooseRunner selects an own online runner using a pin/app-launch preference, not client-machine identity. Preferences are model/effort plus runnerId. Each runner reports one status per harness. Provider account email/plan is frozen on dispatch and re-probed on start, but the run card lacks machine identity. Messages and router assume one active run per chat. Each chat currently shares a runner-local working directory. There is no authenticated remote filesystem/command/preview transport or enforced folder-only execution boundary.

## Ordered implementation

1. **Connection contract and deterministic selection.** Add metadata-only connection profiles to harness status (stable local ID, name, default marker, optional provider identity). Resolve chat override > global selection > current runner default. Prefer verified same-account local connections; otherwise use the explicitly selected host. No arbitrary first-runner fallback. Retain legacy status as the default profile. Extend resume checks with connection identity. Unit-test the matrix, offline/ambiguous selections, sharing and legacy migration.
2. **Machine identity propagation.** Runner prints a structured non-secret registered-runner marker; desktop retains it and returns it over the preload bridge. Web subscribes/polls local status. Dispatch and router receive validated source-runner context. Browser clients without local identity must choose a connection. Never infer machine identity from hostname or login.
3. **Local profile execution.** Add local metadata-only profile registration/default management to runner configuration via a validated runner command exposed in desktop Settings. Probe each profile with per-process CODEX_HOME/CLAUDE_CONFIG_DIR. Strip inherited provider credential environment overrides for explicit isolated profiles. Keep default profiles backward compatible. Pass exact profile to probe and start; check expected identity before execution and detect account-change events where supported. Test concurrent environment isolation, path validation and missing profiles. Sign-in stays in provider CLI.
4. **Backend persistence and preview.** Add optional schema fields for connection preference, per-person chat overrides, dispatch origin and immutable run connection/host attribution. Validate ownership, membership and opt-in on preview, dispatch and claim. Resolve preview and send through the same function. Freeze the preview's connection identity at send and reject stale account selection rather than silently reroute. Retain historical runs. Add backend authorization and dispatch tests.
5. **Settings and composer UI.** Editable machine names, local profile list/add/default controls, global provider account choice, chat account override, resolved account + execution machine in composer, account/host in run details. Keep model changes from clearing connection preferences. Show offline/unavailable state without fallback. Follow tokens.css and existing form styles; verify desktop and narrow composer behavior.
6. **Concurrent agent runs.** Replace chat-wide exclusivity with requester/agent-targeted runs and explicit run steering. Include owner in messages and individual stop controls. Update router to avoid stealing an active run or using arbitrary machine defaults. Isolate local work directories for concurrent runs before enabling parallel writes; shared git landing requires serialization/conflict handling. Test same-harness/different-owner dispatch and explicit cross-owner steering.
7. **Shared resources and services.** Add workspace-scoped resource grants, automatic contribution policy, revocation and an audited request protocol separate from provider routing. Implement host-side file operations with canonical-path/symlink enforcement, then contained command execution and opt-in installation. Add authenticated preview forwarding with host-down handling. OS containment must be verified on macOS/Windows/Linux before advertising unrestricted commands limited to a folder. This is a separate transport/security subsystem, not accomplished by changing account routing. Do not expose stub controls as functioning sharing.
8. **Validation and rollout.** Run focused contract/harness/backend tests, all relevant TypeScript checks and production web/desktop builds. Visual-check settings/composer with multiple hosts and identities. Provider login tests require actual independent accounts and must be reported separately from mocked tests. Backend deployment and desktop replacement affect ongoing work; prepare artifacts, document exact rollout and outstanding platform validation. Do not restart active user runs just to update the app.

## Acceptance cases

- Four named machines never route locally-defaulted work to a different machine.
- Global preference and per-chat override survive changing model/effort and opening another client.
- Two independent profiles on one host never modify process-global environment or share resume cursors.
- Missing, signed-out, revoked, ambiguous and changed connections fail visibly.
- Teammates cannot use unshared provider accounts; shared resource access never changes account ownership.
- Existing run settings remain immutable; stopping/steering one run does not affect another.
- API keys/credentials and profile directory contents are never uploaded. Email alone never proves account equivalence.
- UI states actual account/host before dispatch and preserves historical metadata after rename.

## Progress

- [x] Record decision and complete matrix.
- [x] Write implementation plan before code changes.
- [x] Connection contract and routing.
- [x] Local machine identity.
- [x] Isolated local profiles.
- [x] Backend preference/preview/dispatch.
- [x] Settings/composer/attribution.
- [x] Concurrent agents and isolated work.
- [x] Shared-resource transport and container execution; platform limits below.
- [x] Verification and rollout notes.


## Implemented storage and behavior

The existing `beam-backend` Convex project is the shared metadata and coordination service. No additional project/account is needed. `users` stores global harness preferences, personal chat overrides, and the automatic/approval sharing setting. `runners` stores editable machine labels and reported connection metadata. Each run freezes the selected connection, account metadata, requester, and machine label. `workspaceResources` stores grants; `resourceRequests` queues and audits authorized operations.

Provider credentials remain exclusively in provider-managed local profiles. Beam's `~/.beam/connections.json` contains names, IDs, directories, and defaults, never credential contents. New profiles use separate directories; registration and login do not sign out another profile. The desktop launches the provider's own CLI for login. Explicit profiles strip inherited credential environment overrides before probing or execution. Existing CLI accounts continue to be the initial local defaults.

Shared folders stay on their original host. Mounting a repository in a shared chat contributes that worktree automatically; additional folders and preview ports can be added in Context → Workspace → Shared resources. New private-chat resources remain private. The optional approval setting keeps new resources private until their owner enables sharing. Revocation is rechecked at enqueue, claim, while commands are running, and before returning results. File writes require the hash from a preceding read to catch intervening edits. Contributing an already revoked resource does not silently re-enable it.

Agent runs for different people/harnesses have separate worktrees and branch suffixes. Normal messages only steer the author's matching agent; an explicit Reply control targets another active run. Independent stop controls and owner-qualified headings distinguish simultaneous runs. Existing PR branch conflicts still surface through git rather than overwriting another checkout.

Local paths/ports remain in runner-local resource descriptors. Convex temporarily relays command text/output, file text, and preview bodies; a scheduled mutation removes request payloads/results after ten minutes, retaining minimal audit metadata. This is authenticated relay storage, not end-to-end encryption or a synchronized folder. Existing chat transcripts may retain content the agent quotes in its normal response.

## Verification — 2026-09-23

- All workspace and backend tests passed (`pnpm test`); opt-in simulation integration cases and the container test are skipped in the normal suite.
- Final focused routing/backend checks passed: 17 tests for four-machine selection, named/default profiles, verified identity vs email, access revocation, preference precedence, stale preview rejection, migration, attribution, simultaneous owners, and resource grants.
- After adding the rollout compatibility guard, all 67 backend tests passed, including rejecting legacy runners before dispatch and requiring work-directory acknowledgement at claim.
- The resource container test was also run separately with `BEAM_RESOURCE_CONTAINER_TEST=1`: all four local resource tests passed. A real Docker container wrote inside a temporary shared directory while sibling host files and the Docker socket were unavailable.
- All workspace TypeScript checks passed. Convex type/schema validation and dry-run deployment passed.
- Desktop main/preload, bundled runner, and production web builds passed. The existing Vite large-chunk warning remains.
- Actual settings/composer components were rendered with synthetic two-machine/multiple-profile data in a temporary browser fixture. Verified monochrome token styles, 480px and 320px composer wrapping, offline error, accessible controls, and exact runner/profile arguments on preference selection. The fixture was removed after verification; no real account preferences were changed for this test.

## Current limits and remaining acceptance work

- Live sign-in with two independent Codex or Claude subscriptions has not been performed. Probes currently report email/plan/auth state, but do not provide a reliable stable account/organization identifier. Therefore equivalent accounts across hosts remain distinct connections; verified-identity matching is implemented and tested but only activates when an adapter can supply that identity. Email is never used to merge accounts. Changes that retain identical reported metadata (for example, replacing one API key with another) cannot yet be detected.
- Interactive terminal login is implemented for macOS, Windows, and Linux, but only this macOS build has been exercised. Cross-device login and Windows/Linux execution remain manual acceptance checks.
- Shared commands require a running Docker installation and use `node:22-bookworm`, with only the selected project mounted, host user credentials omitted, resource limits, and no network by default. Enabling project dependency installation allows container network access; it does not authorize machine-wide installation. Arbitrary native host commands and machine-wide installation are not implemented.
- Previews are authenticated GET/HEAD forwarding with refresh, not WebSockets, hot reload, form/API writes, or a public tunnel. Files are limited to 200 KB for text operations; preview assets to 16 MB. A viewer needs an online paired runner.
- Automatic contribution covers workspace-mounted repositories and explicitly added folders. Incidental files accessed by a provider's native tools do not automatically grant more access.
- Automatic routing preserves the originating machine, but a plain team message does not know which harness will be selected before the router responds. Explicit agent selection shows the resolved account before sending.

## Rollout

The updated desktop main/preload, runner, and web assets are built in `apps/desktop/dist`. Restart the development desktop after current work is finished to load the new bridge and runner. Then refresh Connected harnesses, label each machine, and add/profile-login any additional subscriptions in Settings. Existing installed desktop binaries require a separately packaged update; no public release or installed application replacement was performed in this task. Running desktop/agent processes were left intact. Legacy runners can finish their existing runs, but new runs require an updated runner report and an explicit work-scope acknowledgement; outdated hosts show an update/restart error instead of risking concurrent edits in the old shared directory.

Backend deployed successfully on 2026-09-23 to the existing production deployment `https://cautious-fish-858.convex.cloud`. Convex validated the schema and added the three shared-resource indexes; no indexes were deleted. No new Convex account or project was created.


## Release follow-up

Beam 0.1.5 was publicly released on September 23, 2026 with these changes and username-based identity/mentions. Both macOS architectures are signed, notarized and available through the public updater. Backend deployment and release checks passed. Update each runner host before starting new work. Installed apps and active local runs were not forcibly restarted.
