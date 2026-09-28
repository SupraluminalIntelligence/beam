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
});
