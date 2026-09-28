/**
 * Runs the fea environment's cantilever benchmark on a Modal chat machine through ModalExecutor, the way
 * the gateway will run a job from Convex: submit, inspect until done, read the results manifest, release.
 *
 *   MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway smoke
 *
 * Needs a Modal account (or `modal setup`, which writes ~/.modal.toml). The first run on an account waits
 * for Modal to import the image, about 100 seconds in the spike. Costs cents on the free credit.
 */
import { randomUUID } from "node:crypto";
import { ModalExecutor } from "./modal.ts";
import { modalPort } from "./port.ts";

const FEA = "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:52b46d54c99ce66680ced634a6fca2aa900d118b6089f2df0324184ed940ec0b";
const machine = (process.argv[2] ?? "chat") as "chat" | "8-core";
const executor = new ModalExecutor(modalPort("beam-compute-smoke"));
const jobId = `smoke-${randomUUID().slice(0, 8)}`;
const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

const handle = await executor.submit(jobId, {
  version: 1, kind: "environment", title: "Cantilever smoke test", environment: { name: "fea", image: FEA },
  command: "mpirun -n $BEAM_CORES python /beam/benchmarks/cantilever.py", inputs: [], machine, timeoutSeconds: 900,
}, []);
console.log(`${seconds()} s  submitted ${jobId} as sandbox ${handle.id} on the ${machine} machine`);

let status = await executor.inspect(handle), shown = 0;
while (status.state === "running") {
  if (status.log.length > shown) { process.stdout.write(status.log.slice(shown)); shown = status.log.length; }
  await new Promise(resolve => setTimeout(resolve, 2000));
  status = await executor.inspect(handle);
}
process.stdout.write(status.log.slice(shown));
console.log(`${seconds()} s  ${status.state}${status.error ? `: ${status.error}` : ""}`);
try {
  if (status.state === "succeeded") {
    const manifest = JSON.parse(new TextDecoder().decode(await executor.readOutput(handle, "beam/out/manifest.json")));
    console.log(`${seconds()} s  manifest: ${JSON.stringify(manifest).length} bytes, top-level keys ${Object.keys(manifest).join(", ")}`);
  }
} finally {
  await executor.release(handle);
  console.log(`${seconds()} s  released the sandbox`);
}
process.exit(status.state === "succeeded" ? 0 : 1);
