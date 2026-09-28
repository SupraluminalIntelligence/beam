import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireMember } from "./lib";
import { chargeCents, formatCents } from "../packages/contracts/src/machines";

/**
 * Cloud compute spend. A job reserves its authorized amount (its machine's whole capped life) against
 * the workspace allowance when it is queued, in the same transaction, so two approvals can never
 * overdraw it. While it runs, each report meters its time; it is stopped when it reaches what was
 * authorized. When its machine is confirmed stopped, the metered amount is spent and the rest of the
 * reservation is released.
 */
type Billing = NonNullable<Doc<"computeJobs">["billing"]>;

const budgetFor = (ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) =>
  ctx.db.query("computeBudgets").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).first();
const available = (b: Doc<"computeBudgets"> | null) => b ? b.allowanceCents - b.reservedCents - b.spentCents : 0;

/** Holds a job's authorized amount. Throws, rolling back the approval or submission, when the allowance cannot cover it. */
export async function reserve(ctx: MutationCtx, workspaceId: Id<"workspaces">, billing: Billing): Promise<Billing> {
  if (billing.reserved) return billing;
  const budget = await budgetFor(ctx, workspaceId), left = available(budget);
  if (!budget || billing.authorizedCents > left)
    throw new Error(`This job is authorized up to ${formatCents(billing.authorizedCents)} but the workspace has ${formatCents(Math.max(0, left))} of cloud compute budget left. A workspace owner can raise it in Settings.`);
  await ctx.db.patch(budget._id, { reservedCents: budget.reservedCents + billing.authorizedCents, updatedAt: Date.now() });
  return { ...billing, reserved: true };
}

/** What a job has spent so far: its machine's time since the machine was created, never more than authorized. */
export const metered = (billing: Billing, now: number) =>
  Math.min(billing.authorizedCents, billing.meteredFrom ? chargeCents(billing.centsPerHour, (now - billing.meteredFrom) / 1000) : 0);

/** Moves a job's metered spend into the workspace total and releases the rest of its reservation, once its machine is gone. Idempotent. */
export async function settle(ctx: MutationCtx, job: Doc<"computeJobs">, now: number) {
  if (!job.billing?.reserved) return job.billing;
  const chat = await ctx.db.get(job.chatId);
  const spentCents = metered(job.billing, now);
  const budget = chat && await budgetFor(ctx, chat.workspaceId);
  if (budget) await ctx.db.patch(budget._id, { reservedCents: Math.max(0, budget.reservedCents - job.billing.authorizedCents), spentCents: budget.spentCents + spentCents, updatedAt: now });
  return { ...job.billing, spentCents, reserved: false };
}

export const get = query({ args: { workspaceId: v.id("workspaces") }, handler: async (ctx, { workspaceId }) => {
  await requireMember(ctx, workspaceId);
  const budget = await budgetFor(ctx, workspaceId);
  return budget ? { allowanceCents: budget.allowanceCents, reservedCents: budget.reservedCents, spentCents: budget.spentCents, availableCents: Math.max(0, available(budget)) } : null;
} });

/** Only the workspace's creator sets its allowance, until billing gives workspaces real owners. */
export const setAllowance = mutation({ args: { workspaceId: v.id("workspaces"), allowanceCents: v.number() }, handler: async (ctx, a) => {
  const u = await requireMember(ctx, a.workspaceId);
  const workspace = await ctx.db.get(a.workspaceId);
  if (workspace?.createdBy !== u._id) throw new Error("Only the workspace's creator can change its compute budget");
  if (!Number.isInteger(a.allowanceCents) || a.allowanceCents < 0 || a.allowanceCents > 10_000_000) throw new Error("Use a budget between $0 and $100,000");
  const budget = await budgetFor(ctx, a.workspaceId), now = Date.now();
  if (budget) await ctx.db.patch(budget._id, { allowanceCents: a.allowanceCents, updatedAt: now, updatedBy: u.githubLogin! });
  else await ctx.db.insert("computeBudgets", { workspaceId: a.workspaceId, allowanceCents: a.allowanceCents, reservedCents: 0, spentCents: 0, updatedAt: now, updatedBy: u.githubLogin! });
} });
