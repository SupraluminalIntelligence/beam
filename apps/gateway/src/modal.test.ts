import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputeInput, EnvironmentJobSpec } from "@beam/contracts";
import { JOB_DIR, ModalExecutor, WORK, sandboxName, sandboxShape } from "./modal.ts";
import { FileMissing, type ModalPort, type SandboxPort, type SandboxSpec } from "./port.ts";

const IMAGE = `ghcr.io/supraluminalintelligence/beam-env-fea@sha256:${"a".repeat(64)}`;
const job = (over: Partial<EnvironmentJobSpec> = {}): EnvironmentJobSpec => ({
  version: 1, kind: "environment", title: "Cantilever", environment: { name: "fea", image: IMAGE },
  command: "python /beam/benchmarks/cantilever.py", inputs: [], machine: "chat", timeoutSeconds: 600, ...over,
});
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** An in-memory Modal: sandboxes keyed by name, each with a file map and an entrypoint state. */
class FakeSandbox implements SandboxPort {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  stopped: number | null = null;
  terminated = false;
  constructor(readonly id: string, readonly spec: SandboxSpec) {}
  async poll() { return this.stopped; }
  async exec(command: string[]) {
    this.alive();
    if (command[0] !== "tail") throw new Error("unexpected exec");
    const log = this.files.get(command[3]!);
    return log ? { exitCode: 0, stdout: dec(log).slice(-Number(command[2])) } : { exitCode: 1, stdout: "" };
  }
  async readBytes(path: string) { this.alive(); const f = this.files.get(path); if (!f) throw new FileMissing(path); return f; }
  async size(path: string) { return (await this.readBytes(path)).length; }
  async writeBytes(data: Uint8Array, path: string) { this.alive(); this.files.set(path, data); }
  async makeDirectory(path: string) { this.alive(); this.dirs.add(path); }
  async terminate() { this.terminated = true; this.stopped ??= 143; return this.stopped; }
  finish(code: number, log = "") { this.files.set(`${JOB_DIR}/log`, enc(log)); this.files.set(`${JOB_DIR}/exit`, enc(String(code))); }
  private alive() { if (this.stopped !== null) throw new Error("sandbox has stopped"); }
}
class FakeModal implements ModalPort {
  byName = new Map<string, FakeSandbox>();
  creates = 0;
  async create(spec: SandboxSpec) {
    const existing = this.byName.get(spec.name);
    if (existing && existing.stopped === null) return { sandbox: existing, created: false };
    const sandbox = new FakeSandbox(`sb-${++this.creates}`, spec);
    this.byName.set(spec.name, sandbox);
    return { sandbox, created: true };
  }
  async fromName(name: string) { const s = this.byName.get(name); return s && s.stopped === null ? s : null; }
  async fromId(id: string) { return [...this.byName.values()].find(s => s.id === id) ?? null; }
}

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
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const first = await executor.submit("job1", job(), []);
    modal.byName.get(sandboxName("job1"))!.files.delete(`${JOB_DIR}/go`);
    expect(await executor.submit("job1", job(), [])).toEqual(first);
    expect(modal.creates).toBe(1);
    expect(modal.byName.get(sandboxName("job1"))!.files.has(`${JOB_DIR}/go`)).toBe(false);
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

  it("releases the sandbox once results are collected", async () => {
    const modal = new FakeModal(), executor = new ModalExecutor(modal);
    const handle = await executor.submit("job1", job(), []);
    await executor.release(handle);
    expect(modal.byName.get(sandboxName("job1"))!.terminated).toBe(true);
  });
});
