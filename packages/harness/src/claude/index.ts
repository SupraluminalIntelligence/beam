import type { HarnessStatus } from "@beam/contracts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";
import { cliVersion, withTimeout } from "../version.ts";

/**
 * Claude Code via the Agent SDK. The probe opens a query whose prompt never yields,
 * reads initializationResult().account, and closes. No message is sent, no tokens spent,
 * and Beam never logs in for the user: the CLI finds its own credentials.
 */
const PLAN: Record<string, string> = {
  claudemaxsubscription: "Max", claudemax5xsubscription: "Max 5x", claudemax20xsubscription: "Max 20x",
  claudeprosubscription: "Pro", claudeteamsubscription: "Team", claudeenterprisesubscription: "Enterprise", claudefreesubscription: "Free",
  max: "Max", max5: "Max 5x", max20: "Max 20x", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free",
};
const planLabel = (s: string | undefined) => (s ? PLAN[s.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? s : null);

async function* never(): AsyncGenerator<never> { await new Promise(() => {}); }

export async function probeClaude(): Promise<HarnessStatus> {
  const base = { harness: "claude" as const, probedAt: Date.now(), plan: null, email: null };
  const bin = await which("claude");
  if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "Claude Code (`claude`) is not on PATH. Install it, then run `claude auth login`." };
  const version = await cliVersion(bin);
  let q: ReturnType<typeof query> | null = null;
  try {
    q = query({
      prompt: never() as AsyncIterable<never>,
      options: {
        cwd: tmpdir(), persistSession: false, allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
        env: { ...process.env, CLAUDE_CODE_AUTO_CONNECT_IDE: "0" } as Record<string, string>,
      },
    });
    const init = await withTimeout(q.initializationResult(), 25_000, "claude init");
    const acct = init.account ?? {};
    const provider = acct.apiProvider;
    if (provider && provider !== "firstParty") return { ...base, installed: true, version, auth: "authenticated", plan: provider, message: `Authenticated via ${provider}` };
    const src = (acct.tokenSource ?? "").toLowerCase();
    const apiKey = src.includes("apikey") || src.includes("authtoken");
    if (apiKey) return { ...base, installed: true, version, auth: "authenticated", plan: "API key", email: acct.email ?? null, message: null };
    if (acct.email || acct.subscriptionType) return { ...base, installed: true, version, auth: "authenticated", plan: planLabel(acct.subscriptionType), email: acct.email ?? null, message: null };
    return { ...base, installed: true, version, auth: "unauthenticated", message: "Not signed in. Run `claude auth login`." };
  } catch (e) {
    return { ...base, installed: true, version, auth: "unknown", message: `Could not verify sign-in: ${(e as Error).message}` };
  } finally {
    try { q?.close(); } catch {}
  }
}

export const claudeAdapter: HarnessAdapter = {
  kind: "claude",
  probe: probeClaude,
  async start(_input: StartSession): Promise<Session> { throw new Error("claude adapter: start not implemented (M2)"); },
};
