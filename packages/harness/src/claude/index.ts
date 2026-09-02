import type { HarnessStatus } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";

/**
 * Claude Code via the Agent SDK. Plan: long-lived query() with an async prompt
 * queue; a steer pushes into the live queue; approvals park on canUseTool.
 * Probe: open a query whose prompt never yields, read initializationResult().account,
 * abort. Never spends tokens. Never logs in for the user.
 */
export const claudeAdapter: HarnessAdapter = {
  kind: "claude",
  async probe(): Promise<HarnessStatus> {
    const bin = await which("claude");
    const base = { harness: "claude" as const, probedAt: Date.now(), plan: null, email: null };
    if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "Claude Code (`claude`) not found on PATH" };
    // TODO(M1): SDK init probe -> account.subscriptionType / email / tokenSource
    return { ...base, installed: true, version: null, auth: "unknown", message: "probe not implemented yet" };
  },
  async start(_input: StartSession): Promise<Session> {
    throw new Error("claude adapter: start not implemented (M2)");
  },
};
