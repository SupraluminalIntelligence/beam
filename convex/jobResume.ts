import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChatLogin } from "./lib";
import { chooseRunner } from "./runs";
import { sendAs } from "./messages";
import { jobFinished } from "../packages/contracts/src/compute";

/**
 * Continue when a job finishes. An agent can ask, when it submits a job or a sweep, to be mentioned once
 * every job it submitted together has ended. Whoever approves the job approves that too (in auto mode the
 * person who started the run already has), so agents still speak only when spoken to: Beam sends the
 * mention as that person, like PR auto-fix (github.ts). One mention per group, from the last job to end.
 */
export type JobResume = NonNullable<Doc<"computeJobs">["resume"]>;
/** Waits before trying again when no machine can run the agent: a laptop asleep overnight wakes within these. */
export const RESUME_RETRIES_MS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

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

export const fire = internalMutation({ args: { jobId: v.id("computeJobs") }, handler: async (ctx, { jobId }) => {
  const job = await ctx.db.get(jobId);
  if (!job?.resume || job.resume.sentAt) return;
  const group = await groupOf(ctx, job);
  // The last job to end sends it; one already sent for the group never sends again.
  if (group.some(j => !jobFinished(j.state) || j.resume?.sentAt)) return;
  const mark = (patch: Partial<JobResume>) => Promise.all(group.map(j => ctx.db.patch(j._id, { resume: { ...j.resume!, ...patch } })));
  const by = group.find(j => j.resume?.by)?.resume?.by;
  if (!by) return mark({ error: "Not sent: nobody approved these jobs." });
  if (group.every(j => j.state === "cancelled")) return mark({ error: "Not sent: every job was cancelled." });
  const chat = await ctx.db.get(job.chatId), agent = await ctx.db.get(job.resume.agentId);
  if (!chat || chat.state === "deleted") return;
  if (!agent || (chat.agents && !chat.agents.includes(agent._id))) return mark({ error: `Not sent: @${job.resume.handle} is no longer in this chat.` });
  try {
    await requireChatLogin(ctx, chat._id, by);
    await chooseRunner(ctx, chat, by, agent.harness);
  } catch (e) {
    const tries = (job.resume.tries ?? 0) + 1, wait = RESUME_RETRIES_MS[tries - 1];
    if (wait !== undefined) await ctx.scheduler.runAfter(wait, internal.jobResume.fire, { jobId });
    return mark({ tries, error: `Couldn't start @${agent.handle} for ${by}: ${(e as Error).message}${wait === undefined ? "" : ". Trying again later."}` });
  }
  const ordered = group.slice().sort((a, b) => a.createdAt - b.createdAt);
  const titles = ordered.map(j => ({ title: (j.spec as { title?: string }).title ?? "Job", state: j.state, error: j.error }));
  await sendAs(ctx, chat, by, { chatId: chat._id, text: resumeText(agent.handle, titles, job.resume.note, by), mentionHandle: agent.handle });
  const sentAt = Date.now();
  await Promise.all(group.map(j => { const { error: _, ...kept } = j.resume!; return ctx.db.patch(j._id, { resume: { ...kept, sentAt } }); }));
} });

/** On approval: the approver authorizes continuing too. */
export const approvedResume = (job: Doc<"computeJobs">, login: string) => job.resume ? { resume: { ...job.resume, by: login } } : {};
/** At submission: what the agent asked for, already authorized when no approval step follows. */
export type ResumeRequest = { agentId: Id<"agents">; handle: string; note: string; group: string };
export function newResume(input: ResumeRequest | undefined, requestedBy: string, needsApproval: boolean) {
  if (!input) return {};
  const note = input.note.trim().slice(0, 500);
  if (!note) throw new Error("Say what you'll do when the job finishes");
  return { resume: { ...input, note, ...(needsApproval ? {} : { by: requestedBy }) } };
}
