import type { Agent, HarnessKind, HarnessStatus, RunEvent } from "@beam/contracts";

export interface StartSession {
  runId: string;
  agent: Agent;
  cwd: string;             // the chat's worktree
  resumeCursor: unknown;   // adapter-specific, opaque to everyone else
  systemContext: string;   // chat transcript per context policy, rendered as text
}

/** One shape per harness. Everything else in Beam talks to this. */
export interface HarnessAdapter {
  readonly kind: HarnessKind;
  probe(): Promise<HarnessStatus>;
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
