import type { HarnessStatus } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";

/**
 * Codex via `codex app-server` JSON-RPC over stdio. thread/start, thread/resume,
 * turn/start, turn/interrupt; approvals arrive as server->client requests.
 * Probe: account/read -> { chatgpt: email, planType } | { apiKey } | none.
 */
export const codexAdapter: HarnessAdapter = {
  kind: "codex",
  async probe(): Promise<HarnessStatus> {
    const bin = await which("codex");
    const base = { harness: "codex" as const, probedAt: Date.now(), plan: null, email: null };
    if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "Codex (`codex`) not found on PATH" };
    // TODO(M1): spawn app-server, initialize, account/read
    return { ...base, installed: true, version: null, auth: "unknown", message: "probe not implemented yet" };
  },
  async start(_input: StartSession): Promise<Session> {
    throw new Error("codex adapter: start not implemented (M3)");
  },
};
