import { expect,it } from "vitest";
import { defaultPlanar, PlanarCase, meshKey, SimulationReport, WakeFields, decodeWakeFrames, decodeWakeGeometry, wakeGeometryAt, pitchPoint, simulationOutputs, OPENFOAM_IMAGE, type ProcessJobSpec } from "@beam/contracts";
import { planarMesh,planarFiles } from "./planar.ts";
import { LocalExecutor } from "./local.ts";
import { foamValues } from "./openfoam.ts";
import { mkdtemp,readFile,rm,mkdir,writeFile } from "node:fs/promises";
import { join,dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
it("constructs independent named surfaces for three cylinders and a nonrectangular polygon",()=>{
 const mesh=planarMesh(defaultPlanar);expect(mesh.cells).toBeGreaterThan(1000);expect(mesh.cells).toBeLessThan(12000);
 for(const b of defaultPlanar.boundaries)expect(mesh.files["constant/polyMesh/boundary"]).toContain(b.name);
 const polygon=PlanarCase.parse({...defaultPlanar,bodies:[{name:"wedge",shape:"polygon",vertices:[[0,-.01],[.02,0],[0,.01]],boundary:"wall"}],boundaries:defaultPlanar.boundaries.slice(0,3).concat({name:"wall",type:"wall"})});
 expect(planarMesh(polygon).cells).toBeGreaterThan(1000);expect(planarFiles(polygon)["0/U"]).toContain("wall { type noSlip;");
 expect(meshKey({...defaultPlanar,duration:2})).toBe(meshKey(defaultPlanar));
 expect(meshKey({...defaultPlanar,bodies:defaultPlanar.bodies.slice(0,1)})).not.toBe(meshKey(defaultPlanar));
});
const refinements:NonNullable<typeof defaultPlanar.refinements>=[...defaultPlanar.bodies.map(b=>({name:`near_${b.name}`,kind:"body-distance" as const,body:b.name,size:.00125,distance:.002,transition:.0025})),{name:"wake",kind:"box",min:[.015,-.025],max:[.06,.025],size:.002,transition:.003}];
it("concentrates smaller cells around bodies and in the wake while keeping far field coarse",()=>{
 const config={...defaultPlanar,refinements},m=planarMesh(config);
 const area=(p:number[][])=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length]!;return s+a[0]!*b[1]!-b[0]!*a[1]!;},0))/2;
 const near:number[]=[],far:number[]=[];
 for(const p of m.polygons){const x=p.reduce((s,v)=>s+v[0],0)/3,y=p.reduce((s,v)=>s+v[1],0)/3;(x>.10?far:Math.hypot(x,y)<.009?near:[]).push(area(p));}
 const mean=(a:number[])=>a.reduce((s,v)=>s+v,0)/a.length;
 expect(near.length).toBeGreaterThan(50);expect(far.length).toBeGreaterThan(100);expect(mean(near)).toBeLessThan(mean(far)*.5);
 expect(m.cells).toBeLessThanOrEqual(12000);expect(meshKey(config)).not.toBe(meshKey(defaultPlanar));
 expect(meshKey({...config,duration:1})).toBe(meshKey(config));
 expect(()=>planarMesh({...config,refinements:[{name:"tooFine",kind:"box",min:[-.05,-.04],max:[.15,.04],size:.00005,transition:.01}]})).toThrow(/budget|cells/);
});
it("rejects intersecting bodies, missing patches and invalid fluid loops",()=>{
 expect(PlanarCase.safeParse({...defaultPlanar,bodies:defaultPlanar.bodies.map(b=>({...b,centre:[0,0]}))}).success).toBe(false);
 expect(PlanarCase.safeParse({...defaultPlanar,boundaries:defaultPlanar.boundaries.slice(1)}).success).toBe(false);
 expect(PlanarCase.safeParse({...defaultPlanar,domain:{vertices:[[0,0],[1,1],[0,1],[1,0]],edgeBoundaries:["sides","outlet","sides","inlet"]}}).success).toBe(false);
});
it.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1")("checks diagnostic curl against analytic rotation on a triangular mesh",async()=>{
 const root=await mkdtemp(join(tmpdir(),"beam-curl-test-"));
 try{
  // Solid-body rotation U=(-y,x,0) has exactly curl(U)=(0,0,2).
  // Prescribe the analytic velocity at every boundary face as well as each cell.
  const config=PlanarCase.parse({...defaultPlanar,boundaries:defaultPlanar.boundaries.map(b=>b.type==="symmetry"?{name:b.name,type:"wall"}:b)});
  const mesh=planarMesh(config),files:Record<string,string>={...planarFiles(config),...mesh.files};
  const body=(s:string)=>s.slice(s.indexOf("}\n")+2);
  const points=[...body(mesh.files["constant/polyMesh/points"]).matchAll(/\(([-\d.eE+ ]+)\)/g)].map(m=>m[1]!.split(" ").map(Number));
  const faces=[...body(mesh.files["constant/polyMesh/faces"]).matchAll(/\d+\(([\d ]+)\)/g)].map(m=>m[1]!.split(" ").map(Number));
  const vector=(p:number[])=>`(${-p[1]!} ${p[0]!} 0)`;
  const values=(v:string[])=>`nonuniform List<vector> ${v.length}\n(\n${v.join("\n")}\n)`;
  const internal=mesh.polygons.map(p=>vector([p.reduce((s,v)=>s+v[0],0)/p.length,p.reduce((s,v)=>s+v[1],0)/p.length]));
  const boundaries=[...mesh.files["constant/polyMesh/boundary"].matchAll(/(\w+) \{ type \w+; nFaces (\d+); startFace (\d+); \}/g)].map(m=>{
   if(m[1]==="frontAndBack")return "frontAndBack { type empty; }";
   const velocity=faces.slice(Number(m[3]),Number(m[3])+Number(m[2])).map(face=>vector([0,1].map(k=>face.reduce((s,i)=>s+points[i]![k]!,0)/face.length)));
   return `${m[1]} { type fixedValue; value ${values(velocity)}; }`;
  });
  files["0/U"]=`FoamFile { version 2.0; format ascii; class volVectorField; object U; }\ndimensions [0 1 -1 0 0 0 0]; internalField ${values(internal)}; boundaryField { ${boundaries.join("\n")} }`;
  for(const [name,text] of Object.entries(files)){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),text);}
  const postProcess=()=>promisify(execFile)("docker",["run","--rm","--pull=never","--network","none","--cpus","2","--memory","2g","--pids-limit","256","-v",`${root}:/case`,"--entrypoint","bash",OPENFOAM_IMAGE,"-lc","source /usr/lib/openfoam/openfoam2512/etc/bashrc; cd /case; postProcess -func vorticity -time 0"],{timeout:30000});
  await postProcess();
  const curl=foamValues(await readFile(join(root,"0/vorticity"),"utf8"),mesh.cells,3);
  const owners=body(mesh.files["constant/polyMesh/owner"]).split("(")[1]!.split(")")[0]!.trim().split(/\s+/).map(Number);
  const boundaryCells=new Set<number>();
  for(const m of mesh.files["constant/polyMesh/boundary"].matchAll(/(\w+) \{ type \w+; nFaces (\d+); startFace (\d+); \}/g)){
   if(m[1]!=="frontAndBack")for(let i=Number(m[3]);i<Number(m[3])+Number(m[2]);i++)boundaryCells.add(owners[i]!);
  }
  // Interior least-squares reconstruction is linear-exact. Skew boundary faces
  // use normal-distance closure and retain discretization error, so separately
  // require <2% whole-domain RMS error and no zero/wrong-sign wall patches.
  for(let i=0;i<mesh.cells;i++)if(!boundaryCells.has(i))expect(curl[i*3+2]).toBeCloseTo(2,7);
  const omega=curl.filter((_,i)=>i%3===2);
  expect(Math.sqrt(omega.reduce((s,v)=>s+(v-2)**2,0)/omega.length)/2).toBeLessThan(.02);
  expect(Math.min(...omega)).toBeGreaterThan(1);
 }finally{await rm(root,{recursive:true,force:true});}
},40000);
it.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1").each(["three cylinders","polygon domain and wedge","locally refined cylinders","pitching foil","refined pitching foil"])("meshes and solves agent-composed %s",async(kind)=>{
 const root=await mkdtemp(join(tmpdir(),"beam-planar-test-")),executor=new LocalExecutor(root);
 const config=PlanarCase.parse({...defaultPlanar,duration:.3,frames:6,...(kind==="locally refined cylinders"?{refinements}:{}),...(kind.includes("pitching foil")?{duration:1,frames:20,meshSize:.0025,bodies:[{name:"foil",shape:"polygon",vertices:[[-.005,0],[0,-.002],[.015,0],[0,.002]],boundary:"frontWall"}],boundaries:defaultPlanar.boundaries.slice(0,4),motion:{kind:"pitch",body:"foil",pivot:[0,0],meanAngleDegrees:5,amplitudeDegrees:10,frequencyHz:1},...(kind==="refined pitching foil"?{refinements:[{name:"foilBand",kind:"body-distance",body:"foil",size:.00125,distance:.002,transition:.0025}]}:{})}:{}),...(kind==="polygon domain and wedge"?{
 domain:{vertices:[[-.05,-.04],[.13,-.04],[.15,0],[.13,.04],[-.05,.04]],edgeBoundaries:["sides","outlet","outlet","sides","inlet"]},
 bodies:[{name:"wedge",shape:"polygon",vertices:[[0,-.008],[.018,0],[0,.008]],boundary:"frontWall"}],boundaries:defaultPlanar.boundaries.slice(0,4),
 }:{})});
 const spec=(stage:"mesh"|"solve"):ProcessJobSpec=>({version:1,kind:"process",title:"Planar integration",executable:"beam:openfoam",args:[],inputs:stage==="mesh"?[]:[{assetId:"mesh",path:"mesh-input.json"}],outputs:simulationOutputs(stage,config),timeoutSeconds:240,simulation:{image:OPENFOAM_IMAGE,caseId:"planar",revision:1,stage,config,...(stage==="solve"?{meshJobId:"mesh"}:{})}});
 async function finish(id:string){const until=Date.now()+230000;while(Date.now()<until){const s=await executor.inspect({backend:executor.backend,id});if(s.state!=="running"){expect(s.error,s.log).toBe(null);expect(s.state,s.log).toBe("succeeded");return;}await new Promise(r=>setTimeout(r,300));}throw new Error("Planar test timed out");}
 try{
  await executor.submit("mesh",spec("mesh"),[]);await finish("mesh");
  const bytes=await readFile(join(root,"mesh/work/mesh.json"));
  await executor.submit("solve",spec("solve"),[{path:"mesh-input.json",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),url:`data:application/json;base64,${bytes.toString("base64")}`}]);await finish("solve");
  const report=SimulationReport.parse(JSON.parse(await readFile(join(root,"solve/work/report.json"),"utf8")));
  const fields=WakeFields.parse(JSON.parse(await readFile(join(root,"solve/work/fields.json"),"utf8")));
  const binary=await executor.readOutput({backend:executor.backend,id:"solve"},"frames.bin");const frames=decodeWakeFrames(Uint8Array.from(binary).buffer,fields);
  expect(report.meshOk).toBe(true);expect(report.physicalTime).toBeCloseTo(config.duration);expect(report.maxCourant).toBeLessThan(1);expect(fields.times).toHaveLength(config.frames);expect(fields.kind).toBe("planar-flow");expect(frames.every(Number.isFinite)).toBe(true);
  if(config.motion){
   expect(report.motion?.checkedFrames).toBe(20);expect(report.motion?.minCellAreaM2).toBeGreaterThan(0);
   const geometry=decodeWakeGeometry(Uint8Array.from(await readFile(join(root,"solve/work/geometry.bin"))).buffer,fields);
   const quarter=fields.times.findIndex(t=>Math.abs(t-.25)<1e-5),full=fields.times.findIndex(t=>Math.abs(t-1)<1e-5);
   expect(quarter).toBeGreaterThanOrEqual(0);expect(full).toBeGreaterThanOrEqual(0);
   const atQuarter=wakeGeometryAt(fields,geometry,quarter,quarter,0),atFull=wakeGeometryAt(fields,geometry,full,full,0);
   const tip=pitchPoint([.015,0],config.motion,.25),initial=pitchPoint([.015,0],config.motion,0);
   const nearest=(points:number[][],p:number[])=>Math.min(...points.map(v=>Math.hypot(v[0]!-p[0]!,v[1]!-p[1]!)));
   expect(nearest(atQuarter.polygons.flat(),tip)).toBeLessThan(1e-7);
   expect(nearest(atFull.polygons.flat(),initial)).toBeLessThan(1e-7);
   expect(nearest(atQuarter.polygons.flat(),initial)).toBeGreaterThan(.0001);
   expect(nearest(atQuarter.polygons.flat(),[-.05,-.04])).toBeLessThan(1e-7);
  }
  const extent=fields.polygons.flat();expect(Math.max(...extent.map(p=>p[0]))).toBeCloseTo(.15);
  for(const b of config.bodies){if(b.shape!=="circle")continue;expect(fields.centres.every(p=>Math.hypot(p[0]-b.centre[0],p[1]-b.centre[1])>b.radius*.99)).toBe(true);}
 }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
},260000);
