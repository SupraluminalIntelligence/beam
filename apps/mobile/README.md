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

## Not yet

Push notifications, allow and deny inside inbox rows, the machine picker and agent settings. Push needs backend additions. Careful before any `convex deploy`: as of 26 Sep 2026 production runs about 19 simulation and study functions that are not on `main`, and deploying from a checkout without them removes them.
