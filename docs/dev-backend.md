# Local development on a dev backend

Beam's `pnpm convex` in the main checkout pushes to production (`cautious-fish-858`). Backend work goes to a Convex **dev deployment** instead: your personal one in the same `beam-backend` project, or one per branch. Nothing here touches production.

## Set up a checkout

From the checkout (a worktree works the same way):

```sh
pnpm install
grep CONVEX_DEPLOYMENT ~/Developer/beam/.env.local > .env.local   # a new worktree only: tells the CLI which project
node scripts/dev-backend.mjs
```

The script:

1. selects your personal dev deployment (`npx convex deployment select dev`) and refuses to continue on anything that is not `dev:`;
2. pushes this checkout's `convex/` to it and writes `convex/_generated`;
3. sets `JWT_PRIVATE_KEY`, `JWKS` (a fresh key pair) and `SITE_URL=http://localhost:5173` if they are missing, never printing or overwriting a value;
4. writes `apps/web/.env.local` with the dev deployment's URL. Without it, `pnpm dev:isolated` copies the main checkout's file, which points at production.

`node scripts/dev-backend.mjs --check` reports the same things without changing anything. Apekshik's personal dev deployment is `adorable-cuttlefish-524` (`https://adorable-cuttlefish-524.convex.cloud`).

## Run

```sh
pnpm convex                                                              # watch convex/ and push to the dev deployment
BEAM_CONVEX_URL=https://<dev>.convex.cloud pnpm dev:isolated --runner    # UI, desktop window, and a runner on the dev backend
pnpm dev:isolated --web-only                                             # UI only, in a browser
```

- A runner talks to one backend. `--runner` gives this checkout its own runner profile (`~/.beam-dev-…`); pair it once with the dev backend.
- **Never use `--takeover` with a dev backend.** It runs on `~/.beam`, the profile paired with production.
- Plain `pnpm dev:isolated` (no runner) borrows Beam's runner, which is paired with production, so agent runs from a dev-backend chat never reach it.

## Sign-in

Guest sign-in works with no setup, but **guests cannot own a runner**. To run agents against the dev backend, add GitHub sign-in with its own OAuth app (a production OAuth app has one callback URL, which is production's):

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   - Homepage URL: `http://localhost:5173`
   - Authorization callback URL: `https://<dev>.convex.site/api/auth/callback/github` (the script prints it)
2. Generate a client secret, then set both on the dev deployment yourself:
   ```sh
   npx convex env set AUTH_GITHUB_ID <client id>
   npx convex env set AUTH_GITHUB_SECRET <client secret>
   ```

Optional variables production has and a dev deployment can do without: `OPENROUTER_API_KEY` (features that call OpenRouter), `DEMO_EMAIL` and `DEMO_PASSWORD` (the app-review demo account).

## Several checkouts

Every checkout that runs the script shares your personal dev deployment, so two branches pushing `convex/` replace each other's functions. To test backend branches side by side, give a branch its own deployment and run the script there:

```sh
npx convex deployment create dev/<branch> --type dev --select --expiration "in 14 days"
node scripts/dev-backend.mjs
```

## Before merging

A dev deployment accepts anything. Production does not: installed apps keep calling old functions, so schema changes must stay additive, and CI refuses to deploy if production serves a function `main` lacks. Run `pnpm convex:removals` before merging backend changes.
