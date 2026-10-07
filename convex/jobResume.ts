import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChatLogin } from "./lib";
import { chooseRunner, isLive } from "./runs";
import { sendAs } from "./messages";
import { jobFinished } from "../packages/contracts/src/compute";
import { resolveExecution } from "../packages/contracts/src/execution";

/**
 * Continue when a job finishes. An agent can ask, when it submits a job or a sweep, to be mentioned once
 * every job it submitted together has ended. Whoever approves the job approves that too (in auto mode the
 * person who started the run already has), so agents still speak only when spoken to: Beam sends the
 * mention as that person, like PR auto-fix (github.ts). One mention per group, from the last job to end.
 */
export type JobResume = NonNullable<Doc<"computeJobs">["resume"]>;
/** Waits before trying again when no machine can run the agent: a laptop asleep overnight wakes within these. */
export const RESUME_RETRIES_MS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
/** How often to look again while an agent is at work in the chat: a mention then could land in a turn that is ending. */
export const BUSY_RETRY_MS = 60_000;

/** A job just ended: if it asked to continue, check its group in a transaction of its own. */
export async function jobEnded(ctx: MutationCtx, job: Doc<"computeJobs">) {
  if (job.resume && !job.resume.sentAt) await ctx.scheduler.runAfter(0, internal.jobResume.fire, { jobId: job._id });
}

async function groupOf(ctx: MutationCtx, job: Doc<"computeJobs">) {
  const jobs = await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", job.chatId)).collect();
  return jobs.filter(j => j.requestedBy === job.requestedBy && j.resume?.group === job.resume!.group);
}

/** The message the agent gets: what ended, and what it said it would do next. */
export function resumeText(handle: string, jobs: { title: string; state: string; error: string | null }[], note: string, by: string) {
  const lines = jobs.map(j => `- ${j.title}: ${j.state}${j.state === "failed" && j.error ? ` (${j.error.slice(0, 200)})` : ""}`);
  const what = jobs.length === 1 ? "The job you submitted has ended" : `The ${jobs.length} jobs you submitted together have ended`;
  return `@${handle} ${what}:\n${lines.join("\n")}\n\nYou said you'd continue with: ${note}\n\n(Sent by Beam: ${by} approved continuing when these jobs finished.)`;
}

export const fire = internalMutation({ args: { jobId: v.id("computeJobs"), check: v.optional(v.number()) }, handler: async (ctx, { jobId, check }) => {
  const job = await ctx.db.get(jobId);
  if (!job?.resume || job.resume.sentAt) return;
  // One check per group at a time: while a later one is scheduled, a sibling's end leaves it to that one.
  if (job.resume.check !== undefined && job.resume.check !== check) return;
  const group = await groupOf(ctx, job);
  // The last job to end sends it, once every job submitted together exists. Jobs a retried sweep adds to a group
  // that already sent are a new round: they send once they have ended, and the message lists the whole group.
  const pending = group.filter(j => !j.resume?.sentAt);
  if (group.length < Math.max(...pending.map(j => j.resume!.size ?? 1)) || pending.some(j => !jobFinished(j.state))) return;
  const mark = (patch: { [K in keyof JobResume]?: JobResume[K] | undefined }) => Promise.all(pending.map(j => {
    const next: Record<string, unknown> = { ...j.resume!, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return ctx.db.patch(j._id, { resume: next as JobResume });
  }));
  const later = async (wait: number, patch: Partial<JobResume> = {}) => {
    const next = (job.resume!.check ?? 0) + 1;
    await ctx.scheduler.runAfter(wait, internal.jobResume.fire, { jobId, check: next });
    await mark({ ...patch, check: next });
  };
  const by = pending.find(j => j.resume?.by)?.resume?.by;
  if (!by) return mark({ error: "Not sent: nobody approved these jobs." });
  if (pending.every(j => j.state === "cancelled")) return mark({ error: "Not sent: every job was cancelled." });
  const chat = await ctx.db.get(job.chatId), agent = await ctx.db.get(job.resume.agentId);
  if (!chat || chat.state === "deleted") return;
  if (!agent || (chat.agents && !chat.agents.includes(agent._id))) return mark({ error: `Not sent: @${job.resume.handle} is no longer in this chat.` });
  // Like auto-fix, never while an agent is at work here: a turn that is ending would swallow the mention.
  const runs = await ctx.db.query("runs").withIndex("by_chat", q => q.eq("chatId", chat._id)).collect();
  if (runs.some(r => isLive(r.state))) return later(BUSY_RETRY_MS);
  // The machine the job was submitted from runs the agent again when nothing else is chosen, as it did the first time.
  const source = await ctx.db.get(job.runnerId), localRunnerId = source?.ownerLogin === by ? source._id : undefined;
  try {
    await requireChatLogin(ctx, chat._id, by);
    // Everything starting the run checks, so a failure is retried here rather than lost with the mutation.
    const runner = await chooseRunner(ctx, chat, by, agent.harness, localRunnerId);
    const user = await ctx.db.query("users").withIndex("by_login", q => q.eq("githubLogin", by)).first();
    resolveExecution(agent, user?.agentPreferences ?? [], runner);
  } catch (e) {
    const tries = (job.resume.tries ?? 0) + 1, wait = RESUME_RETRIES_MS[tries - 1];
    const error = `Couldn't start @${agent.handle} for ${by}: ${(e as Error).message}`;
    return wait === undefined ? mark({ tries, error, check: undefined }) : later(wait, { tries, error: `${error}. Trying again later.` });
  }
  const ordered = group.slice().sort((a, b) => a.createdAt - b.createdAt);
  const titles = ordered.map(j => ({ title: (j.spec as { title?: string }).title ?? "Job", state: j.state, error: j.error }));
  await sendAs(ctx, chat, by, { chatId: chat._id, text: resumeText(agent.handle, titles, job.resume.note, by), mentionHandle: agent.handle, localRunnerId });
  await mark({ sentAt: Date.now(), error: undefined, check: undefined });
} });

/**
 * A sweep that stopped partway: the jobs it did submit are the whole group, so the continuation still
 * comes once they end. Access is the caller's to check.
 */
export async function closeGroup(ctx: MutationCtx, chatId: Id<"chats">, requestedBy: string, group: string) {
  const members = (await ctx.db.query("computeJobs").withIndex("by_chat", q => q.eq("chatId", chatId)).collect()).filter(j => j.requestedBy === requestedBy && j.resume?.group === group);
  for (const j of members) await ctx.db.patch(j._id, { resume: { ...j.resume!, size: members.length } });
  if (members[0] && members.every(j => jobFinished(j.state))) await jobEnded(ctx, members[0]);
  return members.length;
}

/** On approval: the approver authorizes continuing too. */
export const approvedResume = (job: Doc<"computeJobs">, login: string) => job.resume ? { resume: { ...job.resume, by: login } } : {};
/** At submission: what the agent asked for, already authorized when no approval step follows. */
export type ResumeRequest = { agentId: Id<"agents">; handle: string; note: string; group: string; size: number };
/** The note as stored, so a retried submission can be compared with the one it repeats. */
export const resumeNote = (input: { note: string } | undefined) => input ? input.note.trim().slice(0, 500) : null;
export function newResume(input: ResumeRequest | undefined, requestedBy: string, needsApproval: boolean) {
  if (!input) return {};
  const note = resumeNote(input)!;
  if (!note) throw new Error("Say what you'll do when the job finishes");
  return { resume: { ...input, note, ...(needsApproval ? {} : { by: requestedBy }) } };
}
