import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireChat, readableMutation } from "./lib";
import { runAccess } from "./compute";
import { MACHINE_SHOW } from "../packages/contracts/src/machines";

/**
 * Pictures an agent shows from its machine while it works (machine_show): the mesh before a job, a trial
 * run's residuals. The runner uploads the image, then records it against the run; the run's steps draw it.
 */
export const uploadUrl = readableMutation({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  await runAccess(ctx, a.token, a.runId);
  return ctx.storage.generateUploadUrl();
} });

export const add = readableMutation({
  args: { token: v.string(), runId: v.id("runs"), storageId: v.id("_storage"), name: v.string(), caption: v.string() },
  handler: async (ctx, a): Promise<Id<"machineShows">> => {
    const { run } = await runAccess(ctx, a.token, a.runId);
    const meta = await ctx.db.system.get(a.storageId);
    const fail = async (message: string) => { await ctx.storage.delete(a.storageId); throw new Error(message); };
    if (!meta) throw new Error("The upload is missing");
    if (!Object.values(MACHINE_SHOW.types).includes(meta.contentType ?? "")) return fail("Show a PNG, JPEG, GIF, WebP or SVG image");
    if (meta.size > MACHINE_SHOW.maxBytes) return fail(`Show an image of ${MACHINE_SHOW.maxBytes / 2 ** 20} MB or less`);
    if (a.name.length > 255 || a.caption.length > 200) return fail("Keep the name under 255 characters and the caption under 200");
    const shown = await ctx.db.query("machineShows").withIndex("by_run", q => q.eq("runId", a.runId)).collect();
    if (shown.length >= MACHINE_SHOW.perRun) return fail(`A run can show at most ${MACHINE_SHOW.perRun} pictures`);
    if (await ctx.db.query("machineShows").withIndex("by_storage", q => q.eq("storageId", a.storageId)).first()) throw new Error("This upload is already shown");
    return ctx.db.insert("machineShows", {
      runId: a.runId, chatId: run.chatId, storageId: a.storageId, name: a.name, caption: a.caption,
      contentType: meta.contentType!, size: meta.size, createdAt: Date.now(),
    });
  },
});

/** A run's pictures, oldest first, for anyone who can read its chat. */
export const forRun = query({ args: { runId: v.id("runs") }, handler: async (ctx, { runId }) => {
  const run = await ctx.db.get(runId);
  if (!run) return [];
  await requireChat(ctx, run.chatId);
  const shown = await ctx.db.query("machineShows").withIndex("by_run", q => q.eq("runId", runId)).collect();
  return Promise.all(shown.map(async s => ({ id: s._id, name: s.name, caption: s.caption, url: await ctx.storage.getUrl(s.storageId), createdAt: s.createdAt })));
} });
