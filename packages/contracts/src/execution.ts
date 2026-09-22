import { z } from "zod";

export const ModelCatalog = z.array(z.object({ model: z.string(), name: z.string(), efforts: z.array(z.string()) }));
const Statuses = z.array(z.object({ harness: z.string(), auth: z.string(), email: z.string().nullable().optional(), plan: z.string().nullable().optional(), models: ModelCatalog.optional() }));
export type Preference = { harness: string; model: string; effort: string; runnerId?: string };
type Runner = { _id: string; ownerLogin: string; online: boolean; lastSeen: number; harnesses: unknown; launchedByApp: boolean; allowSharedRuns?: boolean };
export function selectRunner<R extends Runner>(runners: R[], options: { login: string; harness: string; selected?: string | undefined; pinned?: string | null; members: string[]; now: number }): R {
  const ready = runners.filter((r) => (!options.selected || options.selected === r._id)
    && options.members.includes(r.ownerLogin)
    && (r.ownerLogin === options.login || (options.selected === r._id && r.allowSharedRuns === true))
    && r.online && r.lastSeen > options.now - 90_000
    && (Statuses.safeParse(r.harnesses).data ?? []).some((h) => h.harness === options.harness && h.auth === "authenticated"));
  ready.sort((a, b) => Number(b._id === options.pinned) - Number(a._id === options.pinned) || Number(b.launchedByApp) - Number(a.launchedByApp));
  if (!ready[0]) throw new Error(options.selected ? "Your selected connection is unavailable or no longer shared. Choose a connection in agent settings." : `Your ${options.harness} connection is unavailable. Open Beam on your machine, sign in, or choose an explicitly shared connection in agent settings.`);
  return ready[0];
}

export function resolveExecution(agent: { harness: string; model: string; effort: string }, preferences: Preference[], runner: Pick<Runner, "ownerLogin" | "harnesses">) {
  const preference = preferences.find((p) => p.harness === agent.harness) ?? agent;
  const status = Statuses.parse(runner.harnesses).find((h) => h.harness === agent.harness);
  if (!status || status.auth !== "authenticated") throw new Error("Selected harness is not signed in");
  let { model, effort } = preference;
  let modelName = model;
  if (agent.harness === "codex") {
    if (!status.models?.length) throw new Error("Refresh Connected harnesses to discover this connection's Codex models.");
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
    const entry = status.models.find((m) => normalize(m.model) === normalize(model) || normalize(m.name) === normalize(model));
    if (!entry) throw new Error(`${model} is unavailable on the selected Codex connection. Choose an available model in agent settings.`);
    model = entry.model;
    modelName = entry.name;
    if (effort === "max" && !entry.efforts.includes(effort)) effort = ["ultra", "xhigh", "high", "medium", "low", "minimal", "none"].find((e) => entry.efforts.includes(e)) ?? effort;
    if (!entry.efforts.includes(effort)) throw new Error(`${model} does not support ${effort} reasoning. Choose a supported effort.`);
  }
  return { model, modelName, effort, accountOwner: runner.ownerLogin, accountEmail: status.email ?? null, accountPlan: status.plan ?? null };
}

type Resumable = { runnerId: string; dispatchedBy: string; execution?: { accountOwner: string; accountEmail: string | null; model: string; effort: string } };
export function canResume(previous: Resumable, next: Resumable) {
  return previous.runnerId === next.runnerId && previous.dispatchedBy === next.dispatchedBy
    && !!previous.execution && !!next.execution
    && previous.execution.accountOwner === next.execution.accountOwner
    && previous.execution.accountEmail === next.execution.accountEmail
    && previous.execution.model === next.execution.model && previous.execution.effort === next.execution.effort;
}
