import { describe, expect, it, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import { simulationTools } from "./simulationTools.ts";

const IMAGE = "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:" + "a".repeat(64);
// As Convex returns it: fields in alphabetical order, not the schema's.
const stored = { command: "python solve.py", environment: { image: IMAGE, name: "fea" }, files: [], kind: "files", parameters: [{ label: "Tip load", name: "tip_load", unit: "N", value: 500 }], timeoutSeconds: 600 };

describe("run_version", () => {
  it("says so, rather than promising a mention, when a retried request key returns a job Beam already mentioned", async () => {
    const client = {
      query: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => ({ _id: args["id"], state: "succeeded", resume: { note: "refine", sentAt: 1 } })),
      mutation: vi.fn(async () => "job-1"),
    } as unknown as ConvexClient;
    const run = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "run_version")!;
    const out = JSON.parse(String(await run.run({ id: "sim", version: 5, machine: "local", requestKey: "k", continueWith: "refine" })));
    expect(out).toMatchObject({ jobId: "job-1", reused: true });
    expect(out.next).toMatch(/no mention is coming/);
  });

  it("treats a continuation Beam gave up on as settled, and one still being retried as coming", async () => {
    let resume: Record<string, unknown> = { note: "refine", error: "Couldn't start @claude", tries: 4 };
    const client = {
      query: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => ({ _id: args["id"], state: "succeeded", resume })),
      mutation: vi.fn(async () => "job-1"),
    } as unknown as ConvexClient;
    const run = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "run_version")!;
    const args = { id: "sim", version: 5, machine: "local", requestKey: "k", continueWith: "refine" };
    expect(JSON.parse(String(await run.run(args)))).toMatchObject({ reused: true });
    resume = { ...resume, check: 2 };
    expect(JSON.parse(String(await run.run(args)))).toMatchObject({ submitted: true });
  });
});

describe("sweep", () => {
  it("saves a version per new value, derived from the base, and runs the base itself for its own value", async () => {
    let version = 5;
    const saves: Record<string, unknown>[] = [], runs: number[] = [];
    const client = {
      query: vi.fn(async () => ({ simulations: [{ id: "sim", name: "Cantilever", version, versions: [{ version: 5, setup: stored }] }] })),
      mutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
        if ("setup" in args) { saves.push(args); return { id: "sim", version: ++version, unchanged: false }; }
        runs.push(args["version"] as number); return `job-${args["version"]}`;
      }),
    } as unknown as ConvexClient;
    const sweep = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "sweep")!;
    const out = JSON.parse(String(await sweep.run({ id: "sim", version: 5, parameter: "tip_load", values: [250, 500, 1000], machine: "local", requestKey: "k" })));
    expect(out.runs.map((r: { value: number; version: number }) => [r.value, r.version])).toEqual([[250, 6], [500, 5], [1000, 7]]);
    expect(saves.map(s => [s["version"], s["from"]])).toEqual([[5, 5], [6, 5]]);
    expect(runs).toEqual([6, 5, 7]);
  });

  it("asks to continue once for the whole sweep, and closes the group if it stops partway", async () => {
    let version = 5, n = 0;
    const calls: Record<string, unknown>[] = [];
    const client = {
      query: vi.fn(async () => ({ simulations: [{ id: "sim", name: "Cantilever", version, versions: [{ version: 5, setup: stored }] }] })),
      mutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
        if ("setup" in args) return { id: "sim", version: ++version, unchanged: false };
        calls.push(args);
        if ("continueWith" in args && ++n === 2) throw new Error("Another edit saved v7");
        return `job-${n}`;
      }),
    } as unknown as ConvexClient;
    const sweep = simulationTools(client, "token", "run" as never, "/tmp", "ask").find(t => t.name === "sweep")!;
    await expect(sweep.run({ id: "sim", version: 5, parameter: "tip_load", values: [250, 500, 1000], machine: "local", requestKey: "k", continueWith: "compute the GCI" })).rejects.toThrow("v7");
    expect(calls[0]).toMatchObject({ continueWith: "compute the GCI", group: "sweep:k", size: 3 });
    expect(calls.at(-1)).toEqual({ token: "token", runId: "run", group: "sweep:k" });
  });

  it("tells the agent no mention is coming when it can't close a partial sweep", async () => {
    let version = 5, n = 0;
    const client = {
      query: vi.fn(async () => ({ simulations: [{ id: "sim", name: "Cantilever", version, versions: [{ version: 5, setup: stored }] }] })),
      mutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
        if ("setup" in args) return { id: "sim", version: ++version, unchanged: false };
        if (!("continueWith" in args)) throw new Error("Connection lost");
        if (++n === 2) throw new Error("Connection lost");
        return `job-${n}`;
      }),
    } as unknown as ConvexClient;
    const sweep = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "sweep")!;
    await expect(sweep.run({ id: "sim", version: 5, parameter: "tip_load", values: [250, 500, 1000], machine: "local", requestKey: "k", continueWith: "compute the GCI" })).rejects.toThrow(/will not mention you.*follow them with get_job/);
  });
});
