import { JOB_DIR } from "./modal.ts";
import { FileMissing, type ModalPort, type SandboxPort, type SandboxSpec } from "./port.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** An in-memory Modal: sandboxes keyed by name, each with a file map and an entrypoint state. */
export class FakeSandbox implements SandboxPort {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  stopped: number | null = null;
  terminated = false;
  readonly id: string;
  readonly spec: SandboxSpec;
  constructor(id: string, spec: SandboxSpec) { this.id = id; this.spec = spec; }
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
export class FakeModal implements ModalPort {
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

