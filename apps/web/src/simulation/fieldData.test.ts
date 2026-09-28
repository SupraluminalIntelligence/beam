import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResultField } from "@beam/contracts";
import { load, nice } from "./fieldData";

// One triangle with a scalar and a vector at its corners, as beam_out writes it.
const field: ResultField = { name: "part", label: "Part", full: "fields/part.vtu", preview: "preview/part.json", cells: 1, arrays: [{ name: "stress", unit: "Pa" }, { name: "u", unit: "m" }] };
const preview = {
  version: 1, kind: "surface", vertices: 3, triangles: 1, positions: "preview/part.positions.f32", indices: "preview/part.indices.u32",
  arrays: [
    { name: "stress", unit: "Pa", components: 1, association: "point", range: [1, 3], data: "preview/part.stress.f32" },
    { name: "u", unit: "m", components: 3, association: "point", range: [0, 1], data: "preview/part.u.f32" },
  ],
};
const files = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "preview/part.json": preview,
  "preview/part.positions.f32": new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
  "preview/part.indices.u32": new Uint32Array([0, 1, 2]).buffer,
  "preview/part.stress.f32": new Float32Array([1, 2, 3]).buffer,
  "preview/part.u.f32": new Float32Array(9).buffer,
  ...overrides,
});
function publish(all: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = all[url.replace("https://storage.test/", "")];
    return body instanceof ArrayBuffer ? new Response(body) : new Response(JSON.stringify(body));
  }));
  return Object.keys(all).map(rel => ({ path: `beam/out/${rel}`, size: 100, url: `https://storage.test/${rel}` }));
}
afterEach(() => vi.unstubAllGlobals());

describe("loading a field preview", () => {
  it("reads the surface and every array", async () => {
    const d = await load(field, publish(files()), [], new AbortController().signal);
    expect(d.preview.triangles).toBe(1);
    expect([...d.indices]).toEqual([0, 1, 2]);
    expect(d.segments).toBeNull();
    expect([...d.arrays.get("stress")!]).toEqual([1, 2, 3]);
    expect(d.arrays.get("u")!.length).toBe(9);
  });
  it("refuses a buffer whose length disagrees with its preview, as a truncated upload would", async () => {
    await expect(load(field, publish(files({ "preview/part.u.f32": new Float32Array(6).buffer })), [], new AbortController().signal))
      .rejects.toThrow("preview/part.u.f32 is 24 bytes; its preview says 36.");
  });
  it("refuses triangles that point past the vertices", async () => {
    await expect(load(field, publish(files({ "preview/part.indices.u32": new Uint32Array([0, 1, 7]).buffer })), [], new AbortController().signal))
      .rejects.toThrow("refer to vertices it does not have");
  });
  it("reads a scene's line segments and refuses ones that point past the vertices", async () => {
    const scene = { ...preview, segments: { count: 1, indices: "preview/part.segments.u32" }, parts: [{ name: "wall", label: "wall", triangles: [0, 1] }, { name: "lines", label: "lines", segments: [0, 1] }] };
    const d = await load(field, publish(files({ "preview/part.json": scene, "preview/part.segments.u32": new Uint32Array([0, 2]).buffer })), [], new AbortController().signal);
    expect([...d.segments!]).toEqual([0, 2]);
    await expect(load(field, publish(files({ "preview/part.json": scene, "preview/part.segments.u32": new Uint32Array([0, 3]).buffer })), [], new AbortController().signal))
      .rejects.toThrow("lines refer to vertices it does not have");
  });
  it("says when a buffer stayed on the machine for being too large", async () => {
    const outputs = publish(files()).filter(o => !o.path.endsWith("u.f32"));
    const kept = [{ path: "beam/out/preview/part.u.f32", reason: "larger than 20 MB; kept on the machine, since large-output storage is not configured" }];
    await expect(load(field, outputs, kept, new AbortController().signal)).rejects.toThrow("was not uploaded (larger than 20 MB; kept on the machine, since large-output storage is not configured)");
  });
  it("fetches a buffer in large-output storage through a short-lived URL", async () => {
    const outputs = publish(files()).map(o => o.path.endsWith("u.f32") ? { ...o, url: null, storage: "r2" as const } : o);
    const resolve = vi.fn(async (o: { path: string }) => `https://storage.test/${o.path.replace("beam/out/", "")}`);
    const d = await load(field, outputs, [], new AbortController().signal, resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]![0]).toMatchObject({ path: "beam/out/preview/part.u.f32" });
    expect(d.arrays.get("u")!.length).toBe(9);
    await expect(load(field, outputs, [], new AbortController().signal)).rejects.toThrow("preview/part.u.f32 was not published");
  });
});

it("rounds a deformation scale to 1, 2 or 5 × 10ⁿ", () => {
  expect([0.9, 1.4, 3, 6, 8, 1700].map(nice)).toEqual([1, 1, 2, 5, 10, 2000]);
});
