import GitHub from "@auth/core/providers/github";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * GitHub is the real sign-in: membership follows repo access and the runner opens PRs with it.
 * Anonymous exists so the app runs before the GitHub OAuth app is configured. Guests get a
 * synthetic login and can be invited by it.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      // `repo` so Beam can list the repos you can push to. The token stays server-side (users.githubToken) and
      // is only read by github.ts actions.
      authorization: { params: { scope: "read:user user:email repo" } },
      profile(p, tokens) {
        const gh = p as { id: number; login: string; name: string | null; email: string | null; avatar_url: string };
        const t = tokens as { access_token?: string; scope?: string };
        return { id: String(gh.id), name: gh.name ?? gh.login, email: gh.email, image: gh.avatar_url, githubLogin: gh.login, githubToken: t.access_token, githubTokenScope: t.scope ?? "" };
      },
    }),
    /** Desktop sign-in: the system browser approves a device code, the app signs in with it. */
    ConvexCredentials({
      id: "device",
      authorize: async (creds, ctx) => {
        const deviceCode = typeof creds["deviceCode"] === "string" ? creds["deviceCode"] : null;
        if (!deviceCode) return null;
        const r = await ctx.runMutation(internal.runnerAuth.consumeDesktop, { deviceCode });
        return r ? { userId: r.userId } : null;
      },
    }),
    Anonymous({
      profile() {
        const tag = Math.random().toString(36).slice(2, 8);
        return { name: `guest-${tag}`, githubLogin: `guest-${tag}`, isAnonymous: true };
      },
    }),
  ],
});
