import type { HarnessStatus } from "@beam/contracts";
import type { HarnessAdapter, Session, StartSession } from "../adapter.ts";
import { which } from "../path.ts";
import { cliVersion } from "../version.ts";

/**
 * omp (oh-my-pi) via `omp --mode rpc`, NDJSON over stdio. Providers and logins are omp's own.
 * Probe for now: installed and version. Provider auth state arrives with the adapter in M3.
 */
export async function probeOmp(): Promise<HarnessStatus> {
  const base = { harness: "omp" as const, probedAt: Date.now(), plan: null, email: null };
  const bin = await which("omp");
  if (!bin) return { ...base, installed: false, version: null, auth: "unknown", message: "omp is not installed. `curl -fsSL https://omp.sh/install | sh`" };
  const version = await cliVersion(bin);
  return { ...base, installed: true, version, auth: "unknown", message: "Providers are configured inside omp with /login <provider>." };
}

export const ompAdapter: HarnessAdapter = { kind: "omp", probe: probeOmp, async start(_input: StartSession): Promise<Session> { throw new Error("omp adapter: start not implemented (M3)"); } };
