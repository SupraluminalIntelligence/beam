/** The Convex deployment this build talks to. */
export const convexUrl = (import.meta.env["VITE_CONVEX_URL"] as string | undefined) ?? "https://cautious-fish-858.convex.cloud";
