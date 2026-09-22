import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCad, type CadImporter } from "./parse";
import { cadFormat, checkCadFile, MAX_CAD_BYTES, triangleCount, validateModel } from "./model";
import { modelBounds } from "./scene";
import { sampleModel } from "./sample";
import { Vector3 } from "three";
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const noKernel = async (): Promise<CadImporter> => { throw new Error("Mesh import must not load a kernel"); };
const ascii = `solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 5 0\nendloop\nendfacet\nendsolid triangle`;
it("loads ASCII and binary STL without inventing units or requiring OpenCascade", async () => {
  const a = await parseCad("part.STL", bytes(ascii), noKernel);
  expect(triangleCount(a)).toBe(1); expect(a.unit).toBe("model units");
  const buffer = new ArrayBuffer(134), view = new DataView(buffer); view.setUint32(80, 1, true);
  [0,0,1,0,0,0,10,0,0,0,5,0].forEach((n,i) => view.setFloat32(84+i*4,n,true));
  const b = await parseCad("part.stl", buffer, noKernel);
  expect([...b.meshes[0]!.positions]).toEqual([...a.meshes[0]!.positions]);
});
it("preserves OBJ parts and never fetches referenced materials or textures", async () => {
  const model = await parseCad("parts.obj", bytes("mtllib https://example.invalid/material.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\no First\nf 1 2 3\no Second\nf 3 2 1"), noKernel);
  expect(model.meshes.map(m=>m.name)).toEqual(["First", "Second"]); expect(triangleCount(model)).toBe(2);
});
it("imports real STEP and IGES through the installed OpenCascade WASM", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("occt-import-js/package.json"));
  const initialize = require("occt-import-js");
  const occt = await initialize({ print: () => {}, printErr: () => {} }) as CadImporter;
  for (const [path, expected] of [["simple-basic-cube/cube.stp", 300], ["cube-10x10mm/Cube 10x10.igs", 10]] as const) {
    const file = readFileSync(join(root, "test/testfiles", path));
    const model = await parseCad(path, Uint8Array.from(file).buffer, async()=>occt);
    expect(model.unit).toBe("mm"); expect(triangleCount(model)).toBeGreaterThanOrEqual(12);
    const size = modelBounds(model).getSize(new Vector3());
    expect(size.x).toBeCloseTo(expected); expect(size.y).toBeCloseTo(expected); expect(size.z).toBeCloseTo(expected);
  }
}, 30_000);
it("rejects unsupported, oversized, empty, corrupt and non-finite geometry", async () => {
  expect(cadFormat("part.stp")).toBe("step"); expect(cadFormat("part.IGS")).toBe("iges");
  expect(()=>checkCadFile("part.exe",10)).toThrow("STEP");
  expect(()=>checkCadFile("part.obj",MAX_CAD_BYTES+1)).toThrow("20 MB");
  expect(()=>checkCadFile("part.obj",0)).toThrow("empty");
  await expect(parseCad("part.obj",bytes("# no surfaces"),noKernel)).rejects.toThrow("No surfaces");
  expect(()=>validateModel({format:"STL",unit:"model units",meshes:[{name:"bad",positions:new Float32Array([NaN,0,0])}]})).toThrow("coordinates");
  expect(()=>validateModel({format:"STEP",unit:"mm",meshes:[{name:"bad",positions:new Float32Array([0,0,0]),indices:new Uint32Array([0,1,2])}]})).toThrow("indices");
  await expect(parseCad("broken.stp",bytes("broken"),async()=>({ReadStepFile:()=>({success:false}),ReadIgesFile:()=>({success:false})}))).rejects.toThrow("could not read");
});
it("ships a sample with separate parts and known millimeter bounds", () => {
  const model=validateModel(sampleModel()); expect(model.meshes).toHaveLength(3);
  expect(modelBounds(model).getSize(new Vector3()).toArray()).toEqual([114,114,70]);
});
