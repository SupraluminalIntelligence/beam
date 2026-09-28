# Windows desktop

Beam builds a native Windows x64 Electron app and a per-user NSIS installer. It uses the installed Windows Git and provider CLIs; WSL is not required for the desktop.

Settings opens a visible PowerShell for installation and sign-in. Codex's npm install uses `npm.cmd` (avoiding PowerShell script execution-policy failures); Claude uses its native PowerShell installer. Both existing and added account sign-ins go through the runner's selected profile. Refreshing the machine also refreshes CLI discovery after installation. Setup actions on remote machine cards copy commands rather than executing them on this desktop.

The Windows environment and npm-shim handling were compared with T3 Code at `d15210cd3da79f9a1a495a6309d912d76362a046`, specifically `DesktopShellEnvironment.ts`, `providerMaintenanceRunner.ts`, and `ClaudeExecutable.ts`. Beam uses its own plain TypeScript implementation; no T3 implementation was copied in this change.

## Development (PowerShell)

Install Node.js 22.16 or newer, pnpm 10.29.1, and Git for Windows. Install native Windows Codex and/or Claude Code executables on PATH and sign in using their CLIs.

```powershell
pnpm install --frozen-lockfile
pnpm exec convex dev --once
node scripts/dev-backend.mjs
$env:BEAM_CONVEX_URL = "https://your-dev-deployment.convex.cloud"
pnpm dev:isolated --runner
```

Select your development project on the first Convex run; follow [dev-backend.md](dev-backend.md) for auth configuration. The helper writes `apps/web/.env.local`. The isolated runner has its own profile and must be paired with that backend. `--takeover` remains macOS-only.

## Build and verify

The bindings can be generated offline for builds and tests:

```powershell
pnpm exec convex codegen --system-udfs --typecheck disable
pnpm --filter @beam/desktop dist:win
node scripts/smoke-windows.mjs
```

The installer is under `apps/desktop/release/Beam-<version>-win-x64-setup.exe`; `win-unpacked/Beam.exe` runs without installation. `dist:win` never publishes. Windows CI builds these artifacts and smoke-tests the packaged renderer, preload, runner pairing against a local fake endpoint, and graceful close. Build the web app with the intended `VITE_CONVEX_URL` and `VITE_SITE_URL` for distribution; absent overrides, its existing defaults select the Beam service.

Windows uses native minimize/maximize/close controls. Closing the window quits Beam after the runner lands active work (up to one minute). Provider sign-in opens PowerShell. The macOS background-close behavior is unchanged.

## Remaining verification and limits

- Local and CI artifacts are unsigned unless Windows signing credentials are configured for electron-builder. The local upgrade test covers unsigned NSIS installs; certificate-backed signing still needs a release validation pass.
- GitHub sign-in, pairing to a real dev deployment, and a complete provider run with commit/push need an authenticated end-to-end check.
- This first target is Windows x64. ARM64 builds have not been validated.
- Local compute is not advertised by the Windows runner. Unix-specific simulation/compute tools and macOS clipboard file formats are outside this desktop port.
- The full test suite currently includes Unix-only compute cases and fixtures requiring Unix paths or symlink privileges; it is not fully green on a default Windows account. The Windows workflow runs the desktop, harness, shutdown, typecheck and packaged smoke checks explicitly.

## Releases and updates

The installed app checks GitHub on startup and every six hours. A person chooses Download; after download they can choose Install, or let it install on quit. Windows installation runs silently after the runner finishes landing its work, and the Install action reopens Beam.

Release assets live in `SupraluminalIntelligence/beam-releases`, a different repository from the source. Before the first automated release, configure **BEAM_RELEASE_TOKEN** as an Actions secret in the **beam source repository**. Use a fine-grained GitHub token limited to `beam-releases`, with **Contents: read and write**, authorized for the organization. The default workflow token cannot write releases in another repository. Do not put the token in source or chat.

The release workflow is:

1. Bump the desktop version to a new stable `x.y.z`, commit, and merge to `main`. The Windows workflow must also be merged before using it.
2. From that clean commit on macOS, run the existing `pnpm --filter @beam/desktop release`. It builds and verifies both Mac architectures in a **draft**, then dispatches Windows CI with the exact source SHA and version.
3. Windows CI checks out that merged SHA, builds the x64 installer, runs tests including a real temporary installed-app upgrade, and uploads the installer, blockmap, and `latest.yml` to the same draft. It verifies local SHA-512 metadata and remote SHA-256 digests before publishing the complete release as latest.

A failure leaves the release in draft, so installed clients keep using the preceding complete release. Retry the Windows workflow from Actions → Windows desktop → Run workflow on `main`, with the same `release_version` and `source_sha`. Published releases are never overwritten; fixes require a new version. The existing `0.1.10` Mac release predates this workflow; the first combined release needs a higher version.

Local checks (no publication):

```powershell
node --test scripts/release-windows.test.mjs
node scripts/release-windows.mjs
node scripts/test-windows-update.mjs
```

The upgrade test builds two versions of the real desktop under a unique app ID, installs to a temporary directory, serves a local feed, downloads through Beam's actual updater, invokes its install action, and verifies the upgraded app starts. It uses fake runner pairing, removes the test installation, and retains test builds for diagnosis. It does not modify an installed Beam or publish a release.
