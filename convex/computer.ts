import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { me } from "./lib";
import { chatAccess, jobSimulationId } from "./compute";
import { JobSpec } from "../packages/contracts/src/compute";
import { MACHINES } from "../packages/contracts/src/machines";
import { LiveView } from "../packages/contracts/src/live";

/**
 * What your computers are doing, across every chat you can see: the job each is running, the jobs
 * queued behind it, the jobs waiting for someone to approve them, and agents working on a chat's
 * machine. The sidebar's "This computer"; the only view of compute that spans chats.
 */
const STATES = ["running", "publishing", "preparing", "queued", "awaiting-approval"] as const;
const ONLINE_MS = 90_000, MACHINE_FRESH_MS = 3 * 60_000;

async function visible(ctx: QueryCtx, chatId: Id<"chats">, login: string) {
  try { return await chatAccess(ctx, chatId, login); } catch { return null; }
}
/** A job's number within its simulation: job 1 is the first asked for. */
async function numberOf(ctx: QueryCtx, job: Doc<"computeJobs">, simulationId: Id<"simulationCases">) {
  // In the order the chat's jobs were created, as the simulation page numbers them.
  const own = (await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", job.chatId)).collect()).filter(j => jobSimulationId(j) === simulationId);
  return own.findIndex(j => j._id === job._id) + 1;
}
const liveOf = (row: Doc<"liveViews"> | null) => { const v = row ? LiveView.safeParse(row.view) : null; return v?.success ? v.data : null; };
/** The numbers worth a glance: how far it has got (iteration or time), and drag or lift when the case reports them. */
const glance = (view: LiveView | null) => view ? [view.quantities[0], view.quantities.find(q => q.name === "Cd" || q.name === "Cl")].filter((q, i, all): q is LiveView["quantities"][number] => !!q && all.indexOf(q) === i) : [];

export const thisComputer = query({ args: {}, handler: async ctx => {
  const login = (await me(ctx)).githubLogin!, now = Date.now();
  const runners = (await ctx.db.query("runners").withIndex("by_owner", q => q.eq("ownerLogin", login)).collect()).filter(r => r.computeBackend === "local-process");
  const jobs = [];
  let hidden = 0;
  for (const runner of runners) for (const state of STATES) for (const job of await ctx.db.query("computeJobs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", state)).take(50)) {
    const chat = await visible(ctx, job.chatId, login);
    if (!chat) { hidden++; continue; }
    const spec = JobSpec.parse(job.spec), simulationId = jobSimulationId(job), sim = simulationId ? await ctx.db.get(simulationId) : null;
    const live = state === "queued" || state === "awaiting-approval" ? null : liveOf(await ctx.db.query("liveViews").withIndex("by_job", q => q.eq("jobId", job._id)).first());
    jobs.push({
      id: job._id, state: job.state, requestedBy: job.requestedBy, needsYou: job.state === "awaiting-approval" && job.requestedBy === login,
      title: spec.title, chatId: job.chatId, chatTitle: chat.title, workspaceId: chat.workspaceId,
      simulation: sim ? { id: sim._id, name: sim.name, draft: !!sim.draft } : null,
      version: spec.kind === "environment" ? spec.simulation?.version ?? null : null, number: sim ? await numberOf(ctx, job, sim._id) : null,
      // A cloud job runs on its cloud machine, not this computer.
      cloud: job.backend !== "local-process" && spec.kind === "environment" ? MACHINES[spec.machine].label : null,
      createdAt: job.createdAt, startedAt: job.startedAt ?? null, timeoutSeconds: spec.timeoutSeconds,
      latest: glance(live),
    });
  }
  // Agents working on a chat's machine right now: a running case read in the last few minutes.
  const machineWork = [];
  for (const runner of runners) for (const run of await ctx.db.query("runs").withIndex("by_runner_state", q => q.eq("runnerId", runner._id).eq("state", "working")).take(20)) {
    const chat = run.studyId ? await visible(ctx, run.chatId, login) : null, sim = chat && run.studyId ? await ctx.db.get(run.studyId) : null;
    if (!chat || !sim) continue;
    const row = (await ctx.db.query("liveViews").withIndex("by_simulation", q => q.eq("simulationId", sim._id)).collect()).find(r => r.source === "machine");
    const view = liveOf(row ?? null);
    if (!row || !view || view.case.state !== "running" || now - row.updatedAt > MACHINE_FRESH_MS) continue;
    machineWork.push({ simulation: { id: sim._id, name: sim.name, draft: !!sim.draft }, chatId: run.chatId, chatTitle: chat.title, workspaceId: chat.workspaceId, case: view.case.path, solver: view.case.solver, latest: glance(view) });
  }
  return {
    machines: runners.map(r => ({ id: r._id, name: r.name, online: r.online && now - r.lastSeen < ONLINE_MS })),
    jobs, machineWork, hidden,
  };
} });
