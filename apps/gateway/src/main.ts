/**
 * The compute gateway: the only Beam process that holds cloud credentials. It claims cloud jobs from
 * Convex with its service token and runs them on Modal.
 *
 *   CONVEX_URL=… BEAM_GATEWAY_TOKEN=… MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway start
 *
 * Convex must hold the token's SHA-256 in BEAM_GATEWAY_TOKEN_SHA256 (see README.md).
 */
import { ConvexClient } from "convex/browser";
import { ModalExecutor } from "./modal.ts";
import { modalPort } from "./port.ts";
import { watchCloudJobs } from "./watch.ts";

const need = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) { console.error(`Set ${name}.`); process.exit(1); }
  return value;
};
const client = new ConvexClient(need("CONVEX_URL"));
const watcher = watchCloudJobs(client, need("BEAM_GATEWAY_TOKEN"), new ModalExecutor(modalPort(process.env["BEAM_MODAL_APP"] ?? "beam-compute")));
console.log("compute gateway: watching for cloud jobs");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { watcher.stop(); void client.close().then(() => process.exit(0)); });
