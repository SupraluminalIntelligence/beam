import { expect, it } from "vitest";
import { ConvexError } from "convex/values";
import * as runners from "./runners";
import * as runs from "./runs";
import * as compute from "./compute";

// Production shows a client only "Server Error" for a plain Error. The runner relays these refusals to agents,
// so they must be ConvexErrors carrying the reason.
const db: any = { query: () => ({ withIndex: () => ({ first: async () => null, collect: async () => [] }) }), get: async () => null };
const call = (fn: any, args: any) => fn._handler({ db }, args);

it.each([
  ["runners.self", runners.self, { token: "brt_nope" }],
  ["runs.queuedFor", runs.queuedFor, { token: "brt_nope" }],
  ["compute.submitSimulationForRun", compute.submitSimulationForRun, { token: "brt_nope", runId: "r", caseId: "c", revision: 1, stage: "mesh", requestKey: "k" }],
])("%s refuses with a reason the runner can relay", async (_, fn, args) => {
  const refusal = call(fn, args);
  await expect(refusal).rejects.toBeInstanceOf(ConvexError);
  await expect(call(fn, args)).rejects.toThrow("runner token invalid or revoked");
});
