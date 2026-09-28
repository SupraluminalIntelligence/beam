import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { defaultDomain3d, defaultAhmedTunnel, ahmedSurface, encodeStl, normalizeModel, decodeModel, measureModel, modelWindTunnel, windsorTunnel, modelInputPath, bodyBounds, type Model3D, insideBody, Domain3DFields, Domain3DMeshView, SimulationReport, decodeDomain3dFrames, type Domain3DCase } from "@beam/contracts";
import { domain3dFiles, domain3dSolveCommands, parseVtkSurface, readDat, streamlineSeeds, triangulateFaces, safeMeshEntries, sliceOffset, domain3dProcesses, writeModelSurfaces } from "@beam/cfd-recipes";
import { runOpenFoam } from "./legacyFoam.ts";

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
it("meshes an Ahmed body from an STL and measures its loads and streamlines",()=>{
 const files=domain3dFiles(defaultAhmedTunnel,4),stl=files["constant/triSurface/body_ahmed.stl"]!;
 expect(files["system/snappyHexMeshDict"]).toContain('body_ahmed { type triSurfaceMesh; file "body_ahmed.stl"; }');
 expect(stl.startsWith("solid body_ahmed")).toBe(true);expect(stl.match(/facet normal/g)?.length).toBe(148);
 const control=files["system/controlDict"]!;
 expect(control).toMatch(/forces \{ type forces; libs \(forces\); rho rhoInf; rhoInf 1.2; CofR \(0\.522 0 0\.19\d*\); patches \(bodyWall\);/);
 expect(control).toMatch(/dragDir \(1 0 0\); pitchAxis \(0 1 0\); magUInf 40; lRef 1\.044; Aref 0\.1120\d*;/);
 expect(files["0/U"]).toContain("ground { type noSlip; }");
 const seeds=streamlineSeeds(defaultAhmedTunnel);
 expect(seeds.length).toBe(63);expect(seeds.every(p=>p[0]<0&&!defaultAhmedTunnel.bodies.some(b=>insideBody(b,p))&&p[2]>0)).toBe(true);
 expect(files["system/streamDict"]).toContain("seedSampleSet { type cloud; axis xyz; points (");
 expect(domain3dSolveCommands(4,true).at(-1)).toMatch(/postProcess -dict system\/streamDict -latestTime .*\|\| true$/);
 // A sideways inlet has no drag direction on +x: forces only, no coefficients or streamlines.
 const side={...defaultAhmedTunnel,boundaries:defaultAhmedTunnel.boundaries.map(b=>b.type==="velocity-inlet"?{...b,velocity:[40,5,0] as [number,number,number]}:b)};
 expect(domain3dFiles(side)["system/controlDict"]).not.toContain("forceCoeffs");expect(streamlineSeeds(side)).toEqual([]);
 expect(domain3dFiles(defaultDomain3d)["system/controlDict"]).toContain("forceCoeffs");
});
// The Ahmed body exported in millimetres with y up, as a CAD tool might hand it over.
const ahmedFile=()=>{const s=ahmedSurface({name:"a",shape:"ahmed",nose:[0,0,0],scale:1,slantDegrees:25,boundary:"w"});const p=s.points.slice();for(let i=0;i<p.length;i+=3){const y=p[i+1]!,z=p[i+2]!;p[i]=p[i]!*1000;p[i+1]=z*1000;p[i+2]=-y*1000;}return encodeStl({points:p,triangles:s.triangles});};
const imported=(sha="q".repeat(44)):Model3D=>{const {measures:{shells,...m}}=normalizeModel(ahmedFile(),"ahmed.stl");return{assetId:"asset",file:"ahmed.stl",sha256:sha,...m};};
it("places an imported surface for snappyHexMesh and refuses one that differs from the study",async()=>{
 const config=modelWindTunnel(imported(),{scale:.001,rotation:[90,0,0]}),body=config.bodies[0]!,dir=await mkdtemp(join(tmpdir(),"beam-model-"));
 try{
  const snappy=domain3dFiles(config)["system/snappyHexMeshDict"]!;
  expect(snappy).toContain('body_model { type triSurfaceMesh; file "body_model.stl"; }');
  // One level more where the surface curves sharply; the parametric Ahmed body keeps one level.
  expect(snappy).toContain("body_model { level (3 4);");expect(domain3dFiles(defaultAhmedTunnel)["system/snappyHexMeshDict"]).toContain("body_ahmed { level (3 3);");
  await mkdir(join(dir,"models"));await writeFile(join(dir,modelInputPath(body)),ahmedFile());
  await writeModelSurfaces(config,dir);
  const placed=measureModel(decodeModel(await readFile(join(dir,"constant","triSurface","body_model.stl")))),b=bodyBounds(body);
  placed.min.forEach((v,i)=>expect(v).toBeCloseTo(b.min[i]!,5));placed.max.forEach((v,i)=>expect(v).toBeCloseTo(b.max[i]!,5));
  // Upright, 1,044 mm long, 288 mm tall and with the volume of the parametric body.
  expect(b.max[0]-b.min[0]).toBeCloseTo(1.044,5);expect(b.max[2]-b.min[2]).toBeCloseTo(.288,5);expect(placed.volume).toBeGreaterThan(0);
  await writeFile(join(dir,modelInputPath(body)),encodeStl(ahmedSurface({name:"a",shape:"ahmed",nose:[0,0,0],scale:1,slantDegrees:35,boundary:"w"})));
  await expect(writeModelSurfaces(config,dir)).rejects.toThrow(/does not match/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it("reads OpenFOAM force and coefficient histories by column name",()=>{
 const force="# Force\n# CofR : (0 0 0)\n#\n# Time            \ttotal_x total_y total_z\tpressure_x pressure_y pressure_z\tviscous_x viscous_y viscous_z\n0.01 1 2 3 4 5 6 7 8 9\n0.02 3 2 1 4 5 6 7 8 9\n";
 expect(readDat(force)).toEqual([{Time:.01,total_x:1,total_y:2,total_z:3,pressure_x:4,pressure_y:5,pressure_z:6,viscous_x:7,viscous_y:8,viscous_z:9},{Time:.02,total_x:3,total_y:2,total_z:1,pressure_x:4,pressure_y:5,pressure_z:6,viscous_x:7,viscous_y:8,viscous_z:9}]);
 expect(readDat("# Time Cd Cl\n0.1 0.3 0.1\n0.2 bad 0.1\n")).toEqual([{Time:.1,Cd:.3,Cl:.1}]);
});
it("reads streamline polylines from the VTK set writer",()=>{
 const vtk="# vtk DataFile Version 2.0\ntrack0\nASCII\nDATASET POLYDATA\n\nPOINTS 5 float\n0 0 0 1 0 0 2 0 0 0 1 0 1 1 0\nLINES 2 7\n3 0 1 2\n2 3 4\n\nPOINT_DATA 5\nFIELD FieldData 2\np 1 5 float\n0 0 0 0 0\nU 3 5 float\n1 0 0 2 0 0 3 0 0 1 0 0 1 0 0\n";
 const t=parseVtkSurface(vtk);
 expect(t.counts).toEqual([3,2]);expect(t.indices).toEqual([0,1,2,3,4]);expect(t.fields["U"]?.values.length).toBe(15);
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
 },600_000); it("snaps an Ahmed body STL above a ground wall and reports loads and streamlines",async()=>{
  // Coarse and short: this checks the pipeline, not the benchmark drag.
  const config={...structuredClone(defaultAhmedTunnel),duration:.02,frames:4,refinements:[{name:"bodySurface",kind:"body",body:"ahmed",level:2,distance:0}]} as Domain3DCase;
  const root=await mkdtemp(join(tmpdir(),"beam-foam3d-")),cwd=process.cwd(),name="beam-foam-0123456789abcdefa4a4";
  try{
   await import("node:fs/promises").then(fs=>Promise.all([fs.mkdir(join(root,"mesh")),fs.mkdir(join(root,"solve"))]));
   process.chdir(join(root,"mesh"));await runOpenFoam({caseId:"c",revision:1,stage:"mesh",config},name);
   expect(SimulationReport.parse(JSON.parse(await readFile("report.json","utf8"))).meshOk).toBe(true);
   const view=Domain3DMeshView.parse(JSON.parse(await readFile("mesh-view.json","utf8")));
   expect(view.surfaces.map(s=>s.name)).toEqual(["centreline","wake","midHeight","bodyWall","ground"]);
   await copyFile("mesh.tar.gz",join(root,"solve","mesh-input.tar.gz"));
   process.chdir(join(root,"solve"));await runOpenFoam({caseId:"c",revision:1,stage:"solve",config,meshJobId:"m"},name);
   const forces=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8"))).domain3d?.forces;
   expect(forces?.cd).toBeGreaterThan(.1);expect(forces?.forceN[0]).toBeGreaterThan(0);expect(forces?.history.length).toBeGreaterThan(10);
   const fields=Domain3DFields.parse(JSON.parse(await readFile("fields.json","utf8")));
   expect(fields.streamlines?.lines.length).toBeGreaterThan(40);
   // Flow over the roof is faster than the 40 m/s free stream.
   expect(fields.streamlines?.range[1]).toBeGreaterThan(40);
  }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
 },600_000); it("meshes and solves an imported STL through the generated tunnel",async()=>{
  // Coarse and short: this checks the import pipeline end to end, not the drag.
  const tunnel=modelWindTunnel(imported(),{scale:.001,rotation:[90,0,0]});
  const config={...tunnel,duration:.02,frames:4,refinements:tunnel.refinements!.filter(r=>r.kind==="body")} as Domain3DCase;
  const root=await mkdtemp(join(tmpdir(),"beam-foam3d-")),cwd=process.cwd(),name="beam-foam-0123456789abcdefb0d1";
  try{
   await Promise.all([mkdir(join(root,"mesh","models"),{recursive:true}),mkdir(join(root,"solve"))]);
   await writeFile(join(root,"mesh",modelInputPath(config.bodies[0]!)),ahmedFile());
   process.chdir(join(root,"mesh"));await runOpenFoam({caseId:"c",revision:1,stage:"mesh",config},name);
   const mesh=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8")));
   expect(mesh.meshOk).toBe(true);
   const view=Domain3DMeshView.parse(JSON.parse(await readFile("mesh-view.json","utf8")));
   expect(view.surfaces.map(s=>s.name)).toEqual(["centreline","wake","midHeight","bodyWall","ground"]);
   // The snapped wall spans the placed body, not the file's millimetres.
   const wall=view.surfaces.find(s=>s.name==="bodyWall")!,xs=wall.points.filter((_,i)=>i%3===0);
   expect(Math.max(...xs)-Math.min(...xs)).toBeCloseTo(1.044,1);
   await copyFile("mesh.tar.gz",join(root,"solve","mesh-input.tar.gz"));
   process.chdir(join(root,"solve"));await runOpenFoam({caseId:"c",revision:1,stage:"solve",config,meshJobId:"m"},name);
   const forces=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8"))).domain3d?.forces;
   expect(forces?.cd).toBeGreaterThan(.1);expect(forces?.referenceArea).toBeCloseTo(.112,2);
  }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
 },900_000); it("meshes the bundled Windsor body, pins included, to checkMesh's quality limits",async()=>{
  // Its pins are about 1.5 surface cells wide; the extra curvature level keeps their cells unskewed.
  const {measures:{shells:_,...m},stl}=normalizeModel(gunzipSync(await readFile(new URL("../../../web/src/simulation/assets/windsor_1.stl.gz",import.meta.url))),"windsor_1.stl");
  const config=windsorTunnel({assetId:"asset",file:"windsor_1.stl",sha256:"q".repeat(44),...m});
  const root=await mkdtemp(join(tmpdir(),"beam-foam3d-")),cwd=process.cwd(),name="beam-foam-0123456789abcdefd1d2";
  try{
   await mkdir(join(root,"models"));await writeFile(join(root,modelInputPath(config.bodies[0]!)),stl);
   process.chdir(root);await runOpenFoam({caseId:"c",revision:1,stage:"mesh",config},name);
   const mesh=SimulationReport.parse(JSON.parse(await readFile("report.json","utf8")));
   expect(mesh.meshOk).toBe(true);expect(mesh.maxSkewness).toBeLessThan(4);expect(mesh.cells).toBeLessThan(200_000);
  }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
 },900_000);
});
