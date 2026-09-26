# Contributing to Beam

Pull requests are welcome at https://github.com/SupraluminalIntelligence/beam. Fork the repository, create a branch, and open a PR against `main`. For larger features, open an issue first so we can agree on the behavior and design.

## Development setup

Use Node.js 22.16 or newer and pnpm 10.29.1 (the version in `package.json`).

```sh
git clone https://github.com/SupraluminalIntelligence/beam.git
cd beam
pnpm install --frozen-lockfile
pnpm exec convex dev --once
```

On the first Convex run, create or select your own development project. This generates the ignored Convex bindings and local deployment configuration. Do not use the Beam production deployment for contribution testing.

Authentication is already implemented in this repository. Configure the signing keys, site URL, and GitHub OAuth credentials on your own deployment following the [Convex Auth setup guide](https://labs.convex.dev/auth/setup). Retain Beam's existing schema and auth providers. GitHub OAuth credentials belong in Convex environment variables, never in source files. Anonymous sign-in is available for initial UI exploration.

Copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_CONVEX_URL` to your development deployment URL. Keep `VITE_SITE_URL=http://localhost:5173` for local browser/device sign-in.

In one terminal, start the frontend:

```sh
pnpm dev:web
```

In another terminal, start the desktop with a separate runner profile and the same backend URL:

```sh
export BEAM_HOME="$HOME/.beam-contributor"
export BEAM_CONVEX_URL="https://your-dev-deployment.convex.cloud"
pnpm dev:desktop
```

The desktop launches its own runner; do not also launch `dev:runner` with the same profile. The URL and profile overrides prevent a development runner from reusing a paired production runner's configuration. Sign in to Codex or Claude Code with the provider's CLI on the runner machine. CFD and shared-container command tests additionally require Docker; ordinary UI and unit tests do not.

Run `pnpm convex` separately when you want backend changes watched and deployed to your own development deployment. Review the selected deployment before running any Convex command.

## Before opening a pull request

```sh
pnpm typecheck
pnpm test
pnpm --filter @beam/web build
pnpm --filter @beam/mobile exec expo export --platform ios --output-dir /tmp/beam-mobile
```

CI runs the same checks. The last one bundles the phone app, which catches imports that typecheck but cannot run on a phone, such as `node:` modules in `packages/contracts` or `packages/reducer`.

Add a line under Unreleased in `CHANGELOG.md` for any change people will notice; the app shows it under Settings › What's new. Describe the behavior that changes, how you verified it, and any limitations. Include screenshots for UI changes. Keep PRs focused and preserve unrelated work. Provider-backed, Docker, and platform-specific integration checks are opt-in; report which ones you actually ran.

Read `AGENTS.md` and the architecture notes in `README.md`. UI changes should use `apps/web/src/tokens.css` and the existing component styles. Provider credentials remain in local CLI profiles; frontend code must not import Electron or Node APIs.

Never commit tokens, `.env.local`, runner profiles, signing certificates, or private conversation data. If reporting a security issue, use GitHub's private vulnerability reporting rather than posting credentials or exploit details in a public issue.

## License

Beam uses the MIT License. Contributions are submitted under the same license. Keep existing third-party copyright and license notices intact.
