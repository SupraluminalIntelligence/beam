import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { EnvironmentJobSpec } from "@beam/contracts";
import { JOB_DIR, ModalExecutor, sandboxName } from "./modal.ts";
import { FakeModal } from "./fake.ts";
import { SandboxRejected } from "./port.ts";
import { watchCloudJobs } from "./watch.ts";

const spec: EnvironmentJobSpec = {
  version: 1, kind: "environment", title: "Cantilever", environment: { name: "fea", image: `ghcr.io/supraluminalintelligence/beam-env-fea@sha256:${"a".repeat(64)}` },
  command: "python run.py", inputs: [], machine: "chat", timeoutSeconds: 600,
};
type Job = { _id: string; state: string; backend: string; spec: EnvironmentJobSpec; log: string; handle?: { backend: string; id: string }; cancelRequestedAt?: number; awaitingRelease?: boolean };

/** Convex as the gateway sees it: pending cloud jobs, claim, and the reports reconcile makes. */
function convex(jobs: Job[], inputs: unknown[] = []) {
  const client = {
    query: vi.fn(async (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "compute:pending") return jobs.filter(j => j.awaitingRelease || !["succeeded", "failed", "cancelled"].includes(j.state)).map(j => ({ ...j }));
      if (name === "compute:inputs") return inputs;
      throw new Error(name);
    }),
    mutation: vi.fn(async (ref: never, args: { id: string; state?: string; handle?: Job["handle"]; log?: string }) => {
      const name = getFunctionName(ref), job = jobs.find(j => j._id === args.id)!;
      if (name === "compute:claim") { if (job.state !== "queued") return false; job.state = "preparing"; return true; }
      if (name === "compute:report") { job.state = args.state!; if (args.handle) job.handle = args.handle; if (["succeeded", "failed", "cancelled"].includes(job.state) && job.handle) job.awaitingRelease = true; return; }
      if (name === "compute:released") { job.awaitingRelease = false; return; }
      if (name === "compute:publishResults") return;
      throw new Error(name);
    }),
  };
  return client as typeof client & ConvexClient;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
afterEach(() => vi.restoreAllMocks());

it("claims queued cloud jobs, runs them side by side, and frees each machine once its outcome is recorded", async () => {
  const jobs: Job[] = ["a", "b"].map(id => ({ _id: id, state: "queued", backend: "modal-sandbox", spec, log: "" }));
  const modal = new FakeModal(), client = convex(jobs);
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await settle();
  expect(jobs.map(j => j.state)).toEqual(["running", "running"]);
  expect(modal.creates).toBe(2);

  modal.byName.get(sandboxName("a"))!.finish(0, "done\n");
  modal.byName.get(sandboxName("b"))!.finish(3);
  await watcher.tick(); await settle();
  expect(jobs.map(j => j.state)).toEqual(["succeeded", "failed"]);
  expect([...modal.byName.values()].every(s => s.terminated)).toBe(true);
  expect(jobs.map(j => j.awaitingRelease)).toEqual([false, false]);
  watcher.stop();
});

it("never launches a job twice when a pass is still in flight or the gateway restarts", async () => {
  const jobs: Job[] = [{ _id: "a", state: "queued", backend: "modal-sandbox", spec, log: "" }];
  const modal = new FakeModal(), client = convex(jobs);
  const first = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await first.tick(); await settle();
  first.stop();
  const restarted = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await settle(); await restarted.tick(); await settle();
  expect(modal.creates).toBe(1);
  expect(jobs[0]!.state).toBe("running");
  restarted.stop();
});

it("leaves jobs for other backends alone and keeps going when Convex is unreachable", async () => {
  const jobs: Job[] = [{ _id: "a", state: "queued", backend: "ec2", spec, log: "" }];
  const client = convex(jobs), errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(new FakeModal()), { intervalMs: 60_000 });
  await settle();
  expect(client.mutation).not.toHaveBeenCalled();
  client.query.mockRejectedValueOnce(new Error("offline"));
  await watcher.tick();
  expect(errors).toHaveBeenCalledWith("pending cloud jobs:", "offline");
  watcher.stop();
});

it("retries a failed release on the next pass before its spend settles", async () => {
  const jobs: Job[] = [{ _id: "a", state: "queued", backend: "modal-sandbox", spec, log: "" }];
  const modal = new FakeModal(), client = convex(jobs), errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await settle();
  const sandbox = modal.byName.get(sandboxName("a"))!;
  sandbox.finish(0);
  const terminate = vi.spyOn(sandbox, "terminate").mockRejectedValueOnce(new Error("Modal is down"));
  await watcher.tick(); await settle();
  expect(jobs[0]).toMatchObject({ state: "succeeded", awaitingRelease: true });
  expect(errors).toHaveBeenCalledWith("job a:", "Modal is down");
  await watcher.tick(); await settle();
  expect(terminate).toHaveBeenCalledTimes(2);
  expect(jobs[0]!.awaitingRelease).toBe(false);
  watcher.stop();
});

it("holds claims while the machines already running fill the limit", async () => {
  const jobs: Job[] = ["a", "b", "c"].map(id => ({ _id: id, state: "queued", backend: "modal-sandbox", spec, log: "" }));
  const modal = new FakeModal(), client = convex(jobs);
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000, concurrency: 2 });
  await settle(); await watcher.tick(); await settle(); await watcher.tick(); await settle();
  expect(modal.creates).toBe(2);
  expect(jobs.map(j => j.state)).toEqual(["running", "running", "queued"]);
  modal.byName.get(sandboxName("a"))!.finish(0);
  await watcher.tick(); await settle();
  expect(jobs[0]).toMatchObject({ state: "succeeded", awaitingRelease: false });
  await watcher.tick(); await settle();
  expect(modal.creates).toBe(3);
  expect(jobs[2]!.state).toBe("running");
  watcher.stop();
});

it("stops a launch that is cancelled while its inputs are still staging", async () => {
  let arrive!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  vi.stubGlobal("fetch", async () => { await arrived; return new Response(new Uint8Array(4)); });
  const inputs = [{ path: "mesh.msh", url: "https://convex/mesh", size: 4, sha256: "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119" }];
  const jobs: Job[] = [{ _id: "a", state: "queued", backend: "modal-sandbox", spec: { ...spec, inputs: [{ path: "mesh.msh", assetId: "as1" }] } as EnvironmentJobSpec, log: "" }];
  const modal = new FakeModal(), client = convex(jobs, inputs);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await settle();
  const sandbox = modal.byName.get(sandboxName("a"))!;
  jobs[0]!.cancelRequestedAt = Date.now();
  await watcher.tick(); await settle();
  expect(sandbox.terminated).toBe(true);
  arrive(); await settle();
  expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(false);
  await watcher.tick(); await settle();
  expect(jobs[0]!.state).toBe("cancelled");
  watcher.stop();
  vi.unstubAllGlobals();
});

it("fails a job whose machine Modal refuses to create, rather than retrying it forever", async () => {
  const jobs: Job[] = [{ _id: "a", state: "queued", backend: "modal-sandbox", spec, log: "" }];
  const modal = new FakeModal(), client = convex(jobs);
  vi.spyOn(modal, "create").mockRejectedValue(new SandboxRejected("Image build for im-1 failed with the exception: manifest unknown"));
  const watcher = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000 });
  await settle();
  expect(jobs[0]!.state).toBe("failed");
  expect(client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "failed", error: expect.stringMatching(/manifest unknown/) }));
  watcher.stop();
});

it("reconciles at most the limit's worth of jobs at once, so outputs are never read for every job together", async () => {
  const jobs: Job[] = ["a", "b", "c"].map(id => ({ _id: id, state: "queued", backend: "modal-sandbox", spec, log: "" }));
  const modal = new FakeModal(), client = convex(jobs);
  const first = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000, concurrency: 3 });
  await settle(); first.stop();
  expect(jobs.map(j => j.state)).toEqual(["running", "running", "running"]);
  const restarted = watchCloudJobs(client, "token", new ModalExecutor(modal), { intervalMs: 60_000, concurrency: 2 });
  await restarted.tick();
  expect(restarted.inFlight.size).toBe(2);
  await settle(); restarted.stop();
});

