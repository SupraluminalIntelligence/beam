import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Minimal JSON-RPC over newline-delimited JSON on a child's stdio. Enough for the app-server. */
export class JsonRpcChild {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: ((method: string, params: unknown) => void)[] = [];
  readonly requests: ((id: number | string, method: string, params: unknown) => void)[] = [];
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((res) => this.child.on("exit", (code) => { for (const p of this.pending.values()) p.reject(new Error(`process exited (${code})`)); this.pending.clear(); res(code); }));
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg && typeof msg === "object" && "id" in msg && !("method" in msg)) {
        const p = this.pending.get(Number(msg.id));
        if (!p) return;
        this.pending.delete(Number(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg && "method" in msg && "id" in msg) {
        for (const h of this.requests) h(msg.id, msg.method, msg.params);
      } else if (msg && "method" in msg) {
        for (const h of this.notifications) h(msg.method, msg.params);
      }
    });
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.next++;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  notify(method: string, params: unknown = {}) { this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  respond(id: number | string, result: unknown) { this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
  kill() { try { this.child.kill(); } catch {} }
}
