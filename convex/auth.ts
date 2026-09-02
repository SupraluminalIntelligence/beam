import GitHub from "@auth/core/providers/github";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * GitHub is the real sign-in: membership follows repo access and the runner opens PRs with it.
 * Anonymous exists so the app runs before the GitHub OAuth app is configured. Guests get a
 * synthetic login and can be invited by it.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      profile(p) {
        const gh = p as { id: number; login: string; name: string | null; email: string | null; avatar_url: string };
        return { id: String(gh.id), name: gh.name ?? gh.login, email: gh.email, image: gh.avatar_url, githubLogin: gh.login };
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
