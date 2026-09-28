import { AlreadyExistsError, ModalClient, NotFoundError, SandboxFilesystemNotFoundError, type App, type Sandbox } from "modal";

/**
 * The few Modal operations the executor needs. Keeping the SDK behind this seam lets the executor's
 * durability rules be tested without an account, and keeps SDK churn (it is pre-1.0) in one file.
 */
export interface SandboxPort {
  readonly id: string;
  /** null while the entrypoint runs; its exit code once the sandbox has stopped. */
  poll(): Promise<number | null>;
  exec(command: string[]): Promise<{ exitCode: number; stdout: string }>;
  /** Throws FileMissing when the path does not exist. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Throws FileMissing when the path does not exist. */
  size(path: string): Promise<number>;
  writeBytes(data: Uint8Array, path: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  terminate(): Promise<void>;
}

export interface SandboxSpec {
  name: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  cpu: number;
  memoryMiB: number;
  gpu?: string;
  timeoutMs: number;
  tags: Record<string, string>;
}

export interface ModalPort {
  /** Creates the named sandbox, or returns the one that already has this name with created: false. */
  create(spec: SandboxSpec): Promise<{ sandbox: SandboxPort; created: boolean }>;
  fromName(name: string): Promise<SandboxPort | null>;
  fromId(id: string): Promise<SandboxPort | null>;
}

export class FileMissing extends Error {
  constructor(path: string) { super(`ENOENT: no such file ${path}`); }
}

const missingAsNull = async <T>(load: () => Promise<T>): Promise<T | null> => {
  try { return await load(); }
  catch (e) { if (e instanceof NotFoundError) return null; throw e; }
};

function wrap(sandbox: Sandbox): SandboxPort {
  const file = async <T>(path: string, read: () => Promise<T>): Promise<T> => {
    try { return await read(); }
    catch (e) { if (e instanceof SandboxFilesystemNotFoundError) throw new FileMissing(path); throw e; }
  };
  return {
    id: sandbox.sandboxId,
    poll: () => sandbox.poll(),
    exec: async command => {
      const process = await sandbox.exec(command);
      const [stdout, exitCode] = await Promise.all([process.stdout.readText(), process.wait()]);
      return { exitCode, stdout };
    },
    readBytes: path => file(path, () => sandbox.filesystem.readBytes(path)),
    size: path => file(path, async () => (await sandbox.filesystem.stat(path)).size),
    writeBytes: (data, path) => sandbox.filesystem.writeBytes(data, path),
    makeDirectory: path => sandbox.filesystem.makeDirectory(path, { createParents: true }),
    terminate: () => sandbox.terminate(),
  };
}

/** The real Modal account, read from MODAL_TOKEN_ID/MODAL_TOKEN_SECRET or ~/.modal.toml. */
export function modalPort(appName = "beam-compute", client = new ModalClient()): ModalPort {
  let app: Promise<App> | null = null;
  const theApp = () => app ??= client.apps.fromName(appName, { createIfMissing: true });
  const fromName = async (name: string) => {
    const found = await missingAsNull(() => client.sandboxes.fromName(appName, name));
    return found && wrap(found);
  };
  return {
    async create(spec) {
      try {
        const sandbox = await client.sandboxes.create(await theApp(), client.images.fromRegistry(spec.image), {
          name: spec.name, command: spec.command, env: spec.env, tags: spec.tags,
          cpu: spec.cpu, memoryMiB: spec.memoryMiB, ...(spec.gpu ? { gpu: spec.gpu } : {}),
          timeoutMs: spec.timeoutMs, blockNetwork: true,
        });
        return { sandbox: wrap(sandbox), created: true };
      } catch (e) {
        if (!(e instanceof AlreadyExistsError)) throw e;
        const existing = await fromName(spec.name);
        if (!existing) throw e;
        return { sandbox: existing, created: false };
      }
    },
    fromName,
    async fromId(id) {
      const found = await missingAsNull(() => client.sandboxes.fromId(id));
      return found && wrap(found);
    },
  };
}
