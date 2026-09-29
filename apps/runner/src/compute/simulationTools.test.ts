import { describe, expect, it, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import { simulationTools } from "./simulationTools.ts";

const IMAGE = "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:" + "a".repeat(64);
// As Convex returns it: fields in alphabetical order, not the schema's.
const stored = { command: "python solve.py", environment: { image: IMAGE, name: "fea" }, files: [], kind: "files", parameters: [{ label: "Tip load", name: "tip_load", unit: "N", value: 500 }], timeoutSeconds: 600 };

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

  const cloudClient = (availableCents: number, failRunAt = Infinity) => {
    let version = 5, runs = 0;
    const saves: unknown[] = [];
    const client = {
      // One answer for both queries the sweep makes: the simulation list and the workspace's cloud budget.
      query: vi.fn(async () => ({ simulations: [{ id: "sim", name: "Cantilever", version, versions: [{ version: 5, setup: stored }] }], enabled: true, availableCents })),
      mutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
        if ("setup" in args) { saves.push(args); return { id: "sim", version: ++version, unchanged: false }; }
        if (++runs >= failRunAt) throw new Error("The workspace has $0.10 of cloud compute budget left");
        return `job-${args["version"]}`;
      }),
    } as unknown as ConvexClient;
    return { client, saves };
  };

  it("refuses a cloud sweep the workspace's budget cannot hold in full, before saving or submitting anything", async () => {
    const { client, saves } = cloudClient(100);
    const sweep = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "sweep")!;
    await expect(sweep.run({ id: "sim", version: 5, parameter: "tip_load", values: [250, 500, 1000], machine: "8-core", requestKey: "k" })).rejects.toThrow(/3 jobs on the 8-core cloud machine can cost up to \$\d+\.\d\d together, but the workspace has \$1\.00/);
    expect(saves).toHaveLength(0);
    expect(vi.mocked(client.mutation)).not.toHaveBeenCalled();
  });

  it("reports the jobs a sweep already submitted when a later one is refused", async () => {
    const { client } = cloudClient(1_000_000, 3);
    const sweep = simulationTools(client, "token", "run" as never, "/tmp", "auto").find(t => t.name === "sweep")!;
    const out = JSON.parse(String(await sweep.run({ id: "sim", version: 5, parameter: "tip_load", values: [250, 500, 1000], machine: "8-core", requestKey: "k" })));
    expect(out.runs.map((r: { value: number; jobId: string }) => [r.value, r.jobId])).toEqual([[250, "job-6"], [500, "job-5"]]);
    expect(out).toMatchObject({ stoppedAt: 1000, error: expect.stringContaining("budget left") });
  });
});
