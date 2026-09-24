import { z } from "zod";

export const ConnectionStatus = z.object({
  harness: z.string(), auth: z.string(), email: z.string().nullable().optional(), plan: z.string().nullable().optional(),
  connectionId: z.string().default("default"), connectionName: z.string().default("Default account"),
  isDefault: z.boolean().default(true), accountIdentity: z.string().optional(),
}).passthrough();
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
export const connectionStatuses = (value: unknown): ConnectionStatus[] => (Array.isArray(value) ? value : []).flatMap(v => {
  const parsed = ConnectionStatus.safeParse(v); return parsed.success ? [parsed.data] : [];
});
export type ConnectionChoice = { runnerId: string; connectionId: string };
export type ConnectionRunner = { _id: string; name: string; ownerLogin: string; online: boolean; lastSeen: number; harnesses: unknown; allowSharedRuns?: boolean };

/** One resolver for preview and dispatch. A signed-out local account never falls back remotely. */
export function resolveConnection<R extends ConnectionRunner>(runners: R[], options: {
  login: string; harness: string; members: string[]; now: number; localRunnerId?: string | undefined;
  choice?: ConnectionChoice | undefined;
}) {
  const { login, harness, choice } = options;
  const all = runners.filter(r => options.members.includes(r.ownerLogin)).flatMap(runner =>
    connectionStatuses(runner.harnesses).filter(s => s.harness === harness).map(status => ({ runner, status })));
  let selected;
  if (choice) {
    selected = all.find(c => c.runner._id === choice.runnerId && c.status.connectionId === choice.connectionId);
    if (!selected || (selected.runner.ownerLogin !== login && !selected.runner.allowSharedRuns)) throw new Error("Selected account is unavailable or no longer shared. Choose another connection.");
    // Only a provider-reported stable identity may link accounts across hosts. Email is not identity.
    if (selected.runner.ownerLogin === login && selected.runner._id !== options.localRunnerId && selected.status.accountIdentity && options.localRunnerId) {
      const local = all.filter(c => c.runner._id === options.localRunnerId && c.runner.ownerLogin === login && c.status.accountIdentity === selected!.status.accountIdentity);
      if (local.length === 1) selected = local[0]!;
      else if (local.length > 1) throw new Error("Several local profiles match this account. Select a local connection.");
    }
  } else {
    if (!options.localRunnerId) throw new Error("Choose a connection. This client has no local runner connected.");
    const local = all.filter(c => c.runner._id === options.localRunnerId && c.runner.ownerLogin === login && c.status.isDefault);
    if (local.length !== 1) throw new Error("Choose a default account for this harness on this machine in Settings.");
    selected = local[0]!;
  }
  if (!selected.runner.online || selected.runner.lastSeen <= options.now - 90_000) throw new Error(`${selected.runner.name} is offline. Reconnect it or select another account.`);
  if (selected.status.auth !== "authenticated") throw new Error(`${selected.status.connectionName} is not signed in. Sign in on ${selected.runner.name}.`);
  return selected;
}
