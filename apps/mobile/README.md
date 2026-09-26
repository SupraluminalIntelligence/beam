# Beam for iPhone

The phone app: read chats, answer agents, react and steer, from anywhere. Expo SDK 57 and Expo Router, on the same Convex backend and shared packages as the desktop app.

Design: `design/beam-mobile-app.html` is the approved clickable prototype; `design/beam-mobile.html` is the design note.

## Layout

| path | role |
|---|---|
| `src/app/` | screens (Expo Router). `(tabs)/` holds Chats, Inbox and You; `chat/[id]/` holds the chat, its details page and the "In this chat" sheet. |
| `src/chat/` | the chat model (`useChat` folds runs with `@beam/reducer`), timeline rows, the markdown renderer, the hold menu |
| `src/lib/` | Convex client, theme tokens (from `apps/web/src/tokens.css`), agent naming, formatting |
| `src/ui/` | text, status squares, avatars (Chladni plates), agent marks, icons |

## Run

```
pnpm install
npx convex codegen --typecheck disable   # convex/_generated is gitignored
cd apps/mobile
pnpm exec expo start                     # scan with Expo Go; use pnpm exec, not npx, in this monorepo
pnpm exec tsc --noEmit && npx vitest run
```

Sign-in reuses the desktop device-code flow: the phone gets a code, you approve it on Beam's website, the phone signs in with the `device` provider.

## Share a build

The Expo project is `@apekshik/beam`. Publish an update that Expo Go can open (runtime version follows the SDK):

```
EAS_NO_VCS=1 npx eas-cli@latest update --branch preview --environment preview --platform ios --non-interactive
```

The project is private: sign in to Expo Go with an account in the project's Expo organization, then open the `exp://u.expo.dev/<project>/group/<group id>` link the command prints.

## TestFlight

Run from `apps/mobile`. The `testflight` profile produces an App Store-signed
release for TestFlight (EAS `distribution: internal` is ad hoc distribution,
not internal TestFlight). Signing and submission require Apple Developer access.

The Apple app is **Beam by Supraluminal** (`6816341937`), on team `L4M75K683P`.
The installed app name remains **Beam**. For API-key authentication, set these
variables in your local shell; never commit the private `.p8` file:

```
export EXPO_ASC_API_KEY_PATH=/absolute/path/to/AuthKey_KEYID.p8
export EXPO_ASC_KEY_ID=YOUR_KEY_ID
export EXPO_ASC_ISSUER_ID=YOUR_ISSUER_ID
export EXPO_APPLE_TEAM_ID=L4M75K683P
export EXPO_APPLE_TEAM_TYPE=INDIVIDUAL
```

```
npx eas-cli@latest build --platform ios --profile testflight
npx eas-cli@latest submit --platform ios --profile testflight --id <build-id> --no-auto-testflight-setup
```

The submission profile reads API-key settings from the shell variables above.
EAS manages the distribution certificate and provisioning profile. Apple
processing and assignment to an internal tester group happen after upload;
automatic tester invitations are disabled by the submission command above.

The build uses the `preview` EAS environment, the existing Beam backend, remote
build-number increments, and the `testflight` update channel. The root
`.easignore` includes the existing `convex/_generated` clients; if missing,
generate those clients before building. This release does not deploy the backend.

Publish compatible JavaScript/assets to installed TestFlight builds with:

```
BEAM_NATIVE_RUNTIME=1 npx eas-cli@latest update --channel testflight --environment preview --platform ios
```

Native builds and updates use fingerprint runtime matching. Native dependency or
configuration changes require another TestFlight build. The Expo Go preview
command above keeps its SDK runtime. Updates are checked on launch and normally
apply on a subsequent launch, not immediately to an already-open app.

## Not yet

Push notifications, allow and deny inside inbox rows, the machine picker and agent settings. Push needs backend additions. Careful before any `convex deploy`: as of 26 Sep 2026 production runs about 19 simulation and study functions that are not on `main`, and deploying from a checkout without them removes them.
