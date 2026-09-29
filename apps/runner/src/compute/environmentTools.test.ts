import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import { environmentTools } from "./environmentTools.ts";

describe("machine_show", () => {
  let dir = "";
  afterEach(async () => { vi.unstubAllGlobals(); if (dir) await rm(dir, { recursive: true, force: true }); });
  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "beam-show-"));
    await writeFile(join(dir, "mesh.png"), new Uint8Array([137, 80, 78, 71]));
    await writeFile(join(dir, "notes.txt"), "not a picture");
    const calls: Record<string, unknown>[] = [];
    const client = { mutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => { calls.push(args); return "storageId" in args ? "show-1" : "https://upload.test"; }) } as unknown as ConvexClient;
    const uploads: { type: string | null; size: number }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      uploads.push({ type: new Headers(init.headers).get("Content-Type"), size: (init.body as Blob).size });
      return new Response(JSON.stringify({ storageId: "blob" }));
    }));
    const tool = environmentTools(client, "token", "run" as never, dir, "default").find(t => t.name === "machine_show")!;
    return { tool, calls, uploads };
  };

  it("uploads a picture from /work as an image and records it against the run", async () => {
    const { tool, calls, uploads } = await setup();
    expect(await tool.run({ path: "/work/mesh.png", caption: "Mesh near the leading edge" })).toBe("Shown in the chat: Mesh near the leading edge");
    expect(uploads).toEqual([{ type: "image/png", size: 4 }]);
    expect(calls.at(-1)).toMatchObject({ token: "token", runId: "run", storageId: "blob", name: "mesh.png", caption: "Mesh near the leading edge" });
  });

  it("refuses files that are not pictures, or outside the thread's directory", async () => {
    const { tool, uploads } = await setup();
    await expect(tool.run({ path: "notes.txt", caption: "x" })).rejects.toThrow("PNG, JPEG, GIF, WebP or SVG");
    await expect(tool.run({ path: "../elsewhere.png", caption: "x" })).rejects.toThrow();
    expect(uploads).toEqual([]);
  });
});
