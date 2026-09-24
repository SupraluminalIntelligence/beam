import type { Agent, HarnessKind, HarnessStatus, RunEvent } from "@beam/contracts";
import type { ZodTypeAny } from "zod";
import type { HarnessProfile } from "./profile.ts";

/** A tool Beam itself offers the model (attach a repo, list repos). Adapters expose these however their harness allows. */
export interface BeamTool {
  name: string;
  description: string;
  schema: Record<string, ZodTypeAny>;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface StartSession {
  profile?: HarnessProfile;
  runId: string;
  agent: Agent;
  cwd: string;             // the chat's worktree, or a scratch directory when no repo is attached
  resumeCursor: unknown;   // adapter-specific, opaque to everyone else
  systemContext: string;   // chat transcript per context policy, rendered as text
  fallbackSystemContext?: string; // recent history when a fresh session replaces an incompatible cursor
  tools: BeamTool[];
}

/** One shape per harness. Everything else in Beam talks to this. */
export interface HarnessAdapter {
  readonly kind: HarnessKind;
  probe(profile?: HarnessProfile, cwd?: string): Promise<HarnessStatus>;
  start(input: StartSession): Promise<Session>;
}

export interface Session {
  /** Send a user turn. While a turn is running this is a steer, delivered at the next turn boundary. */
  send(text: string, messageId: string): Promise<void>;
  /** Cancel the in-flight tool call and deliver nothing. */
  interrupt(): Promise<void>;
  respond(requestId: string, decision: string, by?: string): Promise<void>;
  stop(): Promise<void>;
  events: AsyncIterable<RunEvent>;
  resumeCursor(): unknown;
}
