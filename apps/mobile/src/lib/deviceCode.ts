/** How waiting on a device code ended. "cancelled" means the person backed out or left the screen; nothing else may happen after it. */
export type Wait = "approved" | "expired" | "timeout" | "cancelled";

/**
 * Polls until the code is approved, expires, or the wait is called off. `cancelled` is checked after every await,
 * so a Cancel tap takes effect even if the approval lands a moment later.
 */
export async function waitForApproval(o: {
  status: () => Promise<{ status: string } | null>;
  cancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  everyMs?: number;
  limitMs?: number;
}): Promise<Wait> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = o.now ?? Date.now;
  const started = now();
  while (now() - started < (o.limitMs ?? 15 * 60_000)) {
    await sleep(o.everyMs ?? 2000);
    if (o.cancelled()) return "cancelled";
    const st = await o.status().catch(() => null);
    if (o.cancelled()) return "cancelled";
    if (!st) return "expired";
    if (st.status === "approved") return "approved";
  }
  return "timeout";
}
