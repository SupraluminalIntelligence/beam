import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDomain3d, Domain3DFields, Domain3DMeshView, SimulationReport, decodeDomain3dFrames, type Domain3DCase } from "@beam/contracts";
import { domain3dFiles, parseVtkSurface, triangulateFaces, safeMeshEntries, sliceOffset, domain3dProcesses } from "./domain3d.ts";
import { runOpenFoam } from "./openfoam.ts";

it("generates snappyHexMesh geometry, merged wall patches and turbulence fields",()=>{
 const files=domain3dFiles(defaultDomain3d,4);
 expect(files["system/snappyHexMeshDict"]).toContain("body_sphere { type searchableSphere; centre (0 0 0); radius 0.02; }");
 expect(files["system/snappyHexMeshDict"]).toContain("refine_wake { mode inside; levels ((1e15 1)); }");
 expect(files["system/createPatchDict"]).toContain("name sphereWall; patchInfo { type wall; } constructFrom patches; patches (body_sphere);");
 expect(files["system/blockMeshDict"]).toMatch(/sides \{ type symmetry; faces \(\(0 1 5 4\) \(3 7 6 2\) \(0 3 2 1\) \(4 5 6 7\)\); \}/);
 expect(files["system/decomposeParDict"]).toContain("numberOfSubdomains 4;");
 expect(files["constant/turbulenceProperties"]).toContain("kOmegaSST");
 expect(files["0/omega"]).toContain("sphereWall { type omegaWallFunction;");
 const laminar=domain3dFiles({...defaultDomain3d,turbulence:{model:"laminar"}} as Domain3DCase);
 expect(laminar["constant/turbulenceProperties"]).toContain("simulationType laminar;");
 expect(laminar["0/k"]).toBeUndefined();
 expect(domain3dProcesses(10_000)).toBe(1);expect(domain3dProcesses(100_000)).toBe(4);
});
it("moves slice planes off grid faces by a negligible distance",()=>{
 const shifted=sliceOffset(defaultDomain3d,{normal:"z",offset:0});
 expect(shifted).not.toBe(0);expect(Math.abs(shifted)).toBeLessThan(defaultDomain3d.meshSize/100);
 expect(sliceOffset(defaultDomain3d,{normal:"z",offset:.0123})).toBe(.0123);
});
it("reads OpenFOAM legacy VTK surfaces with point fields",()=>{
 const vtk="# vtk DataFile Version 2.0\ntime='1'\nASCII\nDATASET POLYDATA\nFIELD FieldData 1\nTimeValue 1 1 float\n1\nPOINTS 4 float\n0 0 0 1 0 0 1 1 0 0 1 0\nPOLYGONS 1 5\n4 0 1 2 3\nPOINT_DATA 4\nFIELD FieldData 2\np 1 4 float\n1 2 3 4\nU 3 4 float\n1 0 0 1 0 0 1 0 0 1 0 0\n";
 const s=parseVtkSurface(vtk);
 expect(s.points.length).toBe(12);expect(s.counts).toEqual([4]);expect(s.fields["p"]).toEqual({location:"point",components:1,values:[1,2,3,4]});
 expect(triangulateFaces(s.counts,s.indices)).toEqual([0,1,2,0,2,3]);
 expect(()=>parseVtkSurface(vtk.replace("4 0 1 2 3","4 0 1 2 9"))).toThrow();
});
it("accepts only polyMesh snapshot entries",()=>{
 expect(safeMeshEntries("polyMesh/\npolyMesh/points\npolyMesh/sets/\nmesh-key.json\n")).toBe(true);
 expect(safeMeshEntries("polyMesh/points\n")).toBe(false);
 expect(safeMeshEntries("mesh-key.json\n../etc/passwd\n")).toBe(false);
 expect(safeMeshEntries("mesh-key.json\n/abs\n")).toBe(false);
});

// Explicit opt-in: requires Docker and the pinned image; never pulls or installs during tests.
describe.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1")("real 3D OpenFOAM mesh and turbulent solve",()=>{
 it("snaps a sphere, transfers the mesh archive and exports sampled surfaces",async()=>{
  const config={...structuredClone(defaultDomain3d),duration:.2,frames:4} as Domain3DCase;
  const root=await mkdtemp(join(tmpdir(),"beam-foam3d-")),cwd=process.cwd(),name="beam-foam-0123456789abcdef3d3d";
  try{
   await import("node:fs/promises").then(fs=>Promise.all([fs.mkdir(join(root,"mesh")),fs.mkdir(join(root,"solve"))]));
   process.chdir(join(root,"mesh"));await runOpenFoam({caseId:"c",revision:1,stage:"mesh",config},name);
   const mesh=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8")));
   expect(mesh.meshOk).toBe(true);expect(mesh.cells).toBeGreaterThan(20000);expect(mesh.domain3d?.cellTypes["hexahedra"]).toBeGreaterThan(0);
   const view=Domain3DMeshView.parse(JSON.parse(await readFile("mesh-view.json","utf8")));
   expect(view.surfaces.map(s=>s.name)).toEqual(["midZ","midY","sphereWall"]);
   await copyFile("mesh.tar.gz",join(root,"solve","mesh-input.tar.gz"));
   process.chdir(join(root,"solve"));await runOpenFoam({caseId:"c",revision:1,stage:"solve",config,meshJobId:"m"},name);
   const report=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8")));
   expect(report.physicalTime).toBe(.2);expect(report.domain3d?.processes).toBe(4);expect(report.domain3d?.savedFrames).toBe(4);
   expect(report.domain3d?.maxNutRatio).toBeGreaterThan(0);
   const fields=Domain3DFields.parse(JSON.parse(await readFile("fields.json","utf8")));
   const frames=decodeDomain3dFrames((await readFile("frames.bin")).buffer as ArrayBuffer,fields);
   expect(frames.length).toBe(4*fields.surfaces.reduce((n,s)=>n+s.points.length/3,0)*4);
   // Stagnation pressure 0.5 rho U^2 = 125 Pa bounds the wall maximum after the start-up transient.
   expect(fields.ranges.pressure[1]).toBeGreaterThan(50);
  }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
 },600_000);
});
