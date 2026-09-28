import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputeInput, EnvironmentJobSpec } from "@beam/contracts";
import { JOB_DIR, ModalExecutor, WORK, sandboxName, sandboxShape } from "./modal.ts";
import { ExecutorUnavailable } from "@beam/contracts";
import { FakeModal } from "./fake.ts";
import { FileMissing, SandboxRejected } from "./port.ts";

const IMAGE = `ghcr.io/supraluminalintelligence/beam-env-fea@sha256:${"a".repeat(64)}`;
const job = (over: Partial<EnvironmentJobSpec> = {}): EnvironmentJobSpec => ({
  version: 1, kind: "environment", title: "Cantilever", environment: { name: "fea", image: IMAGE },
  command: "python /beam/benchmarks/cantilever.py", inputs: [], machine: "chat", timeoutSeconds: 600, ...over,
});
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function served(files: Record<string, Uint8Array>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body = files[url];
    return body ? new Response(Uint8Array.from(body)) : new Response("missing", { status: 404 });
  });
}
const input = (path: string, url: string, bytes: Uint8Array, sha = createHash("sha256").update(bytes).digest("hex")): ComputeInput =>
  ({ path, url, size: bytes.length, sha256: sha });

afterEach(() => vi.unstubAllGlobals());

describe("sandboxShape", () => {
  it("maps Beam's machine sizes onto Modal resources", () => {
    expect(sandboxShape("chat")).toEqual({ cpu: 4, memoryMiB: 16 * 1024, cores: 4 });
    expect(sandboxShape("8-core")).toEqual({ cpu: 8, memoryMiB: 32 * 1024, cores: 8 });
    expect(sandboxShape("gpu-8")).toMatchObject({ gpu: "H100:8", cores: 8 });
  });
  it("refuses machines Modal does not back", () => {
    expect(() => sandboxShape("96-core")).toThrow(/does not run on Modal.*chat, 8-core, gpu-1, gpu-8/);
    expect(() => sandboxShape("local")).toThrow(/does not run on Modal/);
  });
});

describe("ModalExecutor", () => {
  it("creates one sealed, named sandbox per job, stages inputs, then starts the command", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal), mesh = enc("mesh bytes");
    served({ "https://store/mesh": mesh });
    const handle = await executor.submit("job1", job({ inputs: [{ assetId: "a1", path: "case/mesh.msh" }] }), [input("case/mesh.msh", "https://store/mesh", mesh)]);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(handle).toEqual({ backend: "modal-sandbox", id: sandbox.id });
    expect(sandbox.spec).toMatchObject({ image: IMAGE, cpu: 4, cpuLimit: 4, memoryMiB: 16384, memoryLimitMiB: 16384, timeoutMs: (300 + 600 + 1800) * 1000 });
    expect(sandbox.spec.env).toMatchObject({ BEAM_COMMAND: "python /beam/benchmarks/cantilever.py", BEAM_CORES: "4", BEAM_TIMEOUT: "600" });
    expect(dec(sandbox.files.get(`${WORK}/case/mesh.msh`)!)).toBe("mesh bytes");
    expect(sandbox.dirs).toContain(`${WORK}/case`);
    expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(true);
  });

  it("never stages a job twice: a repeated submit returns the existing launch", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal), mesh = enc("mesh");
    served({ "https://store/mesh": mesh });
    const spec = job({ inputs: [{ assetId: "a1", path: "mesh.msh" }] }), inputs = [input("mesh.msh", "https://store/mesh", mesh)];
    const first = await executor.submit("job1", spec, inputs);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    sandbox.files.delete(`${WORK}/mesh.msh`);
    expect(await executor.submit("job1", spec, inputs)).toEqual(first);
    expect(await executor.recover("job1")).toEqual(first);
    expect(modal.creates).toBe(1);
    expect(sandbox.files.has(`${WORK}/mesh.msh`)).toBe(false);
  });

  it("resumes staging a launch that was interrupted before its command could start", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal), mesh = enc("mesh");
    served({ "https://store/mesh": mesh });
    const spec = job({ inputs: [{ assetId: "a1", path: "mesh.msh" }] }), inputs = [input("mesh.msh", "https://store/mesh", mesh)];
    const first = await executor.submit("job1", spec, inputs);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    sandbox.files.clear();
    // Neither go nor abort: recover declines it, so reconcile submits again and staging completes.
    expect(await executor.recover("job1")).toBeNull();
    expect(await executor.submit("job1", spec, inputs)).toEqual(first);
    expect(modal.creates).toBe(1);
    expect(dec(sandbox.files.get(`${WORK}/mesh.msh`)!)).toBe("mesh");
    expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(true);
  });

  it("records a staging failure in the sandbox and never starts the command", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal), mesh = enc("mesh");
    served({ "https://store/mesh": mesh });
    const handle = await executor.submit("job1", job({ inputs: [{ assetId: "a1", path: "mesh.msh" }] }), [input("mesh.msh", "https://store/mesh", mesh, "0".repeat(64))]);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(false);
    expect(sandbox.files.has(`${JOB_DIR}/abort`)).toBe(true);
    expect(await executor.inspect(handle)).toMatchObject({ state: "failed", error: "Input snapshot checksum mismatch" });
  });

  it("rejects recipe jobs, local machines and lifetimes Modal cannot hold before creating anything", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    await expect(executor.submit("j", job({ machine: "local" }), [])).rejects.toThrow(/does not run on Modal/);
    await expect(executor.submit("j", job({ timeoutSeconds: 24 * 3600 }), [])).rejects.toThrow(/at most 23.4 hours/);
    const recipe = { version: 1, kind: "process", title: "t", executable: "/bin/true", args: [], inputs: [], outputs: [], timeoutSeconds: 10 };
    await expect(executor.submit("j", recipe as never, [])).rejects.toThrow(/environment jobs/);
    expect(modal.creates).toBe(0);
  });

  it("recovers a launch by job ID after a restart", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    expect(await executor.recover("job1")).toBeNull();
    const handle = await executor.submit("job1", job(), []);
    expect(await new ModalExecutor(modal).recover("job1")).toEqual(handle);
  });

  it("reports running with the log tail, then the command's outcome", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(await executor.inspect(handle)).toEqual({ state: "running", log: "" });
    sandbox.files.set(`${JOB_DIR}/log`, enc("meshing\n"));
    expect(await executor.inspect(handle)).toEqual({ state: "running", log: "meshing\n" });
    sandbox.finish(0, "done\n");
    expect(await executor.inspect(handle)).toEqual({ state: "succeeded", log: "done\n", error: null, exitCode: 0 });
  });

  it.each([
    [124, /time limit/],
    [137, /out of memory/],
    [2, /exited with code 2/],
  ])("explains exit code %i", async (code, message) => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    modal.byName.get(sandboxName("job1"))!.finish(code);
    expect(await executor.inspect(handle)).toMatchObject({ state: "failed", error: expect.stringMatching(message), exitCode: code });
  });

  it("fails without replay when the sandbox stops early or its launch was abandoned", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    sandbox.stopped = 97;
    expect(await executor.inspect(handle)).toMatchObject({ state: "failed", error: expect.stringMatching(/launch was interrupted/) });
    sandbox.stopped = 137;
    expect(await executor.inspect(handle)).toMatchObject({ state: "failed", error: expect.stringMatching(/stopped before/) });
    expect(await executor.inspect({ backend: "modal-sandbox", id: "gone" })).toMatchObject({ state: "failed", error: expect.stringMatching(/no longer exists/) });
  });

  it("cancels a submission that has no handle yet, including one racing its launch", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    await executor.cancelSubmission("job1");
    await expect(executor.submit("job1", job(), [])).rejects.toThrow(/Cancelled before launch/);
    const other = new ModalExecutor(modal);
    await other.submit("job2", job(), []);
    await other.cancelSubmission("job2");
    expect(modal.byName.get(sandboxName("job2"))!.terminated).toBe(true);
  });

  it("reads outputs from the working directory within the size limit", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    sandbox.files.set(`${WORK}/beam/out/manifest.json`, enc("{}"));
    expect(dec(await executor.readOutput(handle, "beam/out/manifest.json"))).toBe("{}");
    await expect(executor.readOutput(handle, "beam/out/missing.json")).rejects.toThrow(/no such file/);
    await expect(executor.readOutput(handle, "../etc/passwd")).rejects.toThrow();
    sandbox.files.set(`${WORK}/big.vtu`, new Uint8Array(20 * 1024 * 1024 + 1));
    await expect(executor.readOutput(handle, "big.vtu")).rejects.toThrow(/20 MB or less/);
  });

  it("cancel returns only once the sandbox has stopped", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    await executor.cancel(handle);
    expect(modal.byName.get(sandboxName("job1"))!.terminated).toBe(true);
    expect(await executor.inspect(handle)).toMatchObject({ state: "failed" });
  });

  it("reports an unanswered call to Modal as unavailable, so the job is retried rather than failed", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    vi.spyOn(sandbox, "poll").mockRejectedValueOnce(new Error("socket hang up"));
    await expect(executor.inspect(handle)).rejects.toBeInstanceOf(ExecutorUnavailable);
    vi.spyOn(modal, "fromId").mockRejectedValueOnce(new Error("503"));
    await expect(executor.readOutput(handle, "beam/out/manifest.json")).rejects.toBeInstanceOf(ExecutorUnavailable);
    await expect(executor.readOutput(handle, "beam/out/manifest.json")).rejects.toThrow(FileMissing);
    expect(await executor.inspect(handle)).toEqual({ state: "running", log: "" });
  });

  it("releases the sandbox once results are collected", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    await executor.release(handle);
    expect(modal.byName.get(sandboxName("job1"))!.terminated).toBe(true);
  });

  it("inspects a launch whose go write went unanswered instead of aborting it", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const create = modal.create.bind(modal);
    vi.spyOn(modal, "create").mockImplementation(async spec => {
      const made = await create(spec), write = made.sandbox.writeBytes.bind(made.sandbox);
      // The write lands in the sandbox but its answer is lost.
      vi.spyOn(made.sandbox, "writeBytes").mockImplementation(async (data, path) => { await write(data, path); if (path.endsWith("/go")) throw new Error("socket hang up"); });
      return made;
    });
    await expect(executor.submit("job1", job(), [])).rejects.toBeInstanceOf(ExecutorUnavailable);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(sandbox.files.has(`${JOB_DIR}/abort`)).toBe(false);
    const handle = await executor.recover("job1");
    expect(handle).toEqual({ backend: "modal-sandbox", id: sandbox.id });
    expect(await executor.inspect(handle!)).toEqual({ state: "running", log: "" });
  });

  it("fails a launch Modal refuses and retries one it did not answer", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    vi.spyOn(modal, "create")
      .mockRejectedValueOnce(new SandboxRejected("Image build for im-1 failed with the exception: manifest unknown"))
      .mockRejectedValueOnce(new Error("503"));
    const refused = await executor.submit("job1", job(), []).catch(e => e);
    expect(refused).not.toBeInstanceOf(ExecutorUnavailable);
    expect(refused.message).toMatch(/Modal could not start a machine for .*manifest unknown/);
    await expect(executor.submit("job1", job(), [])).rejects.toBeInstanceOf(ExecutorUnavailable);
  });

  it("writes the job's parameters and runs the command through the shared job script", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    await executor.submit("job1", job({ parameters: [{ name: "load", value: 1200, unit: "N" }] }), []);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(JSON.parse(dec(sandbox.files.get(`${WORK}/beam/parameters.json`)!))).toEqual({ load: { value: 1200, unit: "N" } });
    expect(sandbox.spec.env["BEAM_SCRIPT"]).toContain("python /beam/benchmarks/cantilever.py");
    expect(sandbox.spec.env["BEAM_SCRIPT"]).toContain("nothing was published");
    expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(true);
  });

  it("retries an input download the server did not finish, and fails one it refused", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal), mesh = enc("mesh");
    const spec = job({ inputs: [{ assetId: "a1", path: "mesh.msh" }] }), inputs = [input("mesh.msh", "https://store/mesh", mesh)];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from(mesh)))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 })));
    await expect(executor.submit("job1", spec, inputs)).rejects.toBeInstanceOf(ExecutorUnavailable);
    await expect(executor.submit("job1", spec, inputs)).rejects.toBeInstanceOf(ExecutorUnavailable);
    const sandbox = modal.byName.get(sandboxName("job1"))!;
    expect(sandbox.files.has(`${JOB_DIR}/abort`)).toBe(false);
    await executor.submit("job1", spec, inputs);
    expect(sandbox.files.has(`${JOB_DIR}/go`)).toBe(true);

    served({});
    const refused = await executor.submit("job2", spec, [input("mesh.msh", "https://store/gone", mesh)]);
    expect(await executor.inspect(refused)).toMatchObject({ state: "failed", error: "Input download failed: 404" });
  });

  it("says when a release stopped the machine, and nothing when it had already stopped", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    expect(await executor.release(handle)).toBeTypeOf("number");
    const terminate = vi.spyOn(modal.byName.get(sandboxName("job1"))!, "terminate");
    expect(await executor.release(handle)).toBeUndefined();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("does not read results from a machine that has stopped", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    modal.byName.get(sandboxName("job1"))!.stopped = 0;
    await expect(executor.readOutput(handle, "beam/out/manifest.json")).rejects.toThrow("stopped before this result was collected");
  });
});
