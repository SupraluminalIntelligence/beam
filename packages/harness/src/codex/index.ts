import type { HarnessStatus } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";
import { withTimeout } from "../version.ts";
import { JsonRpcChild } from "./rpc.ts";

/**
 * Codex via `codex app-server` JSON-RPC over stdio. Probe: initialize, then account/read.
 * { chatgpt: email, planType } means a subscription, { apiKey } an API key, nothing means `codex login`.
 */
const PLAN: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro 20x", prolite: "Pro 5x", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

export const CLIENT_INFO = { name: "beam", title: "Beam", version: "0.0.1" };

export async function probeCodex(): Promise<HarnessStatus> {
  const base = { harness: "codex" as const, probedAt: Date.now(), plan: null, email: null };
  const bin = await which("codex");
  if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "Codex (`codex`) is not on PATH. Install it, then run `codex login`." };
  const rpc = new JsonRpcChild(bin, ["app-server"], process.env);
  try {
    const init = await withTimeout(rpc.request<{ userAgent?: string }>("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }), 15_000, "codex initialize");
    rpc.notify("initialized");
    const version = init.userAgent?.match(/\/(\S+)/)?.[1] ?? null;
    const acct = await withTimeout(rpc.request<{ account?: { type: string; email?: string | null; planType?: string } | null; requiresOpenaiAuth: boolean }>("account/read", {}), 10_000, "codex account/read");
    const a = acct.account;
    if (!a) return acct.requiresOpenaiAuth
      ? { ...base, installed: true, version, auth: "unauthenticated", message: "Not signed in. Run `codex login`." }
      : { ...base, installed: true, version, auth: "authenticated", plan: "external", message: null };
    if (a.type === "chatgpt") return { ...base, installed: true, version, auth: "authenticated", plan: a.planType ? `ChatGPT ${PLAN[a.planType] ?? a.planType}` : "ChatGPT", email: a.email ?? null, message: null };
    if (a.type === "apiKey") return { ...base, installed: true, version, auth: "authenticated", plan: "API key", message: null };
    return { ...base, installed: true, version, auth: "authenticated", plan: a.type, message: null };
  } catch (e) {
    return { ...base, installed: true, version: null, auth: "unknown", message: `Could not verify sign-in: ${(e as Error).message}` };
  } finally {
    rpc.kill();
  }
}

export const codexAdapter: HarnessAdapter = {
  kind: "codex",
  probe: probeCodex,
  async start(_input: StartSession): Promise<Session> { throw new Error("codex adapter: start not implemented (M3)"); },
};
