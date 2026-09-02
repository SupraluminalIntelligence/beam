import type { HarnessStatus } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";

/**
 * omp (oh-my-pi) via `omp --mode rpc`, NDJSON over stdio.
 * prompt / steer / follow_up / abort / set_model / new_session / switch_session in;
 * agent_start / message_update / tool_execution_start|end / agent_end out.
 * Anthropic models through omp need an API key (policy); Claude Code stays the subscription route.
 */
export const ompAdapter: HarnessAdapter = {
  kind: "omp",
  async probe(): Promise<HarnessStatus> {
    const bin = await which("omp");
    const base = { harness: "omp" as const, probedAt: Date.now(), plan: null, email: null };
    if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "omp not found on PATH" };
    return { ...base, installed: true, version: null, auth: "unknown", message: "probe not implemented yet" };
  },
  async start(_input: StartSession): Promise<Session> {
    throw new Error("omp adapter: start not implemented (M3)");
  },
};
