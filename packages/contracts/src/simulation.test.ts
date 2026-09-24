import { expect, it } from "vitest";
import { ChannelCase, defaultPlanar, canonicalMeshKey, defaultChannel, defaultCylinder, SimulationCase, WakeFields, decodeWakeFrames, meshKey, SimulationFields, simulationOutputs } from "./simulation.ts";
import { ProcessJobSpec } from "./compute.ts";
it("rejects unsupported physics and preserves mesh compatibility only for non-geometric edits",()=>{
  expect(ChannelCase.safeParse({...defaultChannel,velocity:1}).success).toBe(false);
  expect(ChannelCase.safeParse({...defaultChannel,length:.01,height:.02}).success).toBe(false);
  expect(ChannelCase.safeParse({...defaultChannel,nx:10000}).success).toBe(false);
  expect(meshKey({...defaultChannel,wallTemperature:320})).toBe(meshKey(defaultChannel));
  expect(meshKey({...defaultChannel,nx:80})).not.toBe(meshKey(defaultChannel));
});
it("requires the reserved OpenFOAM command and exact stage manifests",()=>{
  const mesh={version:1,kind:"process",title:"Mesh",executable:"beam:openfoam",args:[],inputs:[],outputs:simulationOutputs("mesh"),timeoutSeconds:60,simulation:{caseId:"case",revision:1,stage:"mesh",config:defaultChannel}};
  expect(ProcessJobSpec.safeParse(mesh).success).toBe(true);
  expect(ProcessJobSpec.safeParse({...mesh,simulation:undefined}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...mesh,args:["arbitrary"]}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...mesh,executable:"sh"}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...mesh,simulation:{...mesh.simulation,stage:"solve"},outputs:simulationOutputs("solve")}).success).toBe(false);
});
it("rejects a field whose cell count differs or values are non-finite",()=>{
  expect(SimulationFields.safeParse({version:1,centres:[[0,0,0]],velocity:[1],pressure:[0],temperature:[]}).success).toBe(false);
  expect(SimulationFields.safeParse({version:1,centres:[[0,0,0]],velocity:[Infinity],pressure:[0],temperature:[300]}).success).toBe(false);
});

it("bounds the cylinder recipe and invalidates only geometric changes",()=>{
 expect(SimulationCase.parse(defaultCylinder)).toEqual(defaultCylinder);
 expect(SimulationCase.safeParse({...defaultCylinder,reynolds:100000}).success).toBe(false);
 expect(meshKey({...defaultCylinder,reynolds:100})).toBe(meshKey(defaultCylinder));
 expect(meshKey({...defaultCylinder,diameter:.02})).not.toBe(meshKey(defaultCylinder));
 expect(meshKey(defaultCylinder)).not.toBe(meshKey(defaultChannel));
 const sim={caseId:"c",revision:1,stage:"solve",meshJobId:"m",config:defaultCylinder};
 const job={version:1,kind:"process",title:"Wake",executable:"beam:openfoam",args:[],inputs:[{assetId:"a",path:"mesh-input.json"}],outputs:simulationOutputs("solve",defaultCylinder),timeoutSeconds:600,simulation:sim};
 expect(ProcessJobSpec.safeParse(job).success).toBe(true);
 expect(ProcessJobSpec.safeParse({...job,outputs:simulationOutputs("solve")}).success).toBe(false);
});
it("validates temporal addressing and binary playback bounds",()=>{
 const raw={version:1,kind:"cylinder-wake",encoding:"float32-le",times:[.1,.2],centres:[[0,0]],polygons:[[[0,0],[1,0],[0,1]]],ranges:{velocity:[0,1],pressure:[-1,1],vorticity:[-2,2]}};
 const f=WakeFields.parse(raw),bytes=new ArrayBuffer(32);new DataView(bytes).setFloat32(0,.5,true);
 expect(decodeWakeFrames(bytes,f)[0]).toBe(.5);
 expect(()=>decodeWakeFrames(new ArrayBuffer(28),f)).toThrow();
 new DataView(bytes).setFloat32(0,NaN,true);expect(()=>decodeWakeFrames(bytes,f)).toThrow();
 expect(WakeFields.safeParse({...raw,times:[.2,.1]}).success).toBe(false);
 expect(WakeFields.safeParse({...raw,polygons:[]}).success).toBe(false);
});

it("recognizes planar meshes after transport reorders object keys",()=>{
 const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
 expect(meshKey(reorder(defaultPlanar))).toBe(meshKey(defaultPlanar));
 const c=defaultPlanar,legacy=JSON.stringify([c.geometry,c.domain,c.bodies,c.meshSize,c.boundaries.map(b=>[b.name,b.type==="symmetry"?"symmetry":b.type==="wall"?"wall":"patch"])]);
 expect(canonicalMeshKey(legacy)).toBe(meshKey(defaultPlanar));
});

it("validates refinement targets and preserves old unrefined mesh keys",()=>{
 const r={name:"nearBody",kind:"body-distance" as const,body:defaultPlanar.bodies[0]!.name,size:.00125,distance:.002,transition:.003};
 expect(SimulationCase.safeParse({...defaultPlanar,refinements:[r]}).success).toBe(true);
 for(const bad of [{...r,body:"missing"},{...r,size:.01},{...r,transition:.0001},{...r,distance:-1}])expect(SimulationCase.safeParse({...defaultPlanar,refinements:[bad]}).success).toBe(false);
 expect(SimulationCase.safeParse({...defaultPlanar,refinements:[r,r]}).success).toBe(false);
 expect(SimulationCase.safeParse({...defaultPlanar,refinements:[{name:"box",kind:"box",min:[1,1],max:[0,0],size:.001,transition:.01}]}).success).toBe(false);
 expect(meshKey({...defaultPlanar,refinements:[]})).toBe(meshKey(defaultPlanar));
});

it("validates pitching clearance, sampling and mesh identity",async()=>{
 const {PlanarCase,pitchPoint}=await import("./planar.ts");
 const motion={kind:"pitch" as const,body:"frontCylinder",pivot:[0,0] as [number,number],meanAngleDegrees:5,amplitudeDegrees:10,frequencyHz:1};
 const c={...defaultPlanar,duration:1,frames:20,motion};
 expect(PlanarCase.safeParse(c).success).toBe(true);
 for(const bad of [{...motion,body:"missing"},{...motion,amplitudeDegrees:21},{...motion,frequencyHz:2},{...motion,pivot:[-.049,0]}])expect(PlanarCase.safeParse({...c,motion:bad}).success).toBe(false);
 expect(PlanarCase.safeParse({...c,bodies:c.bodies.map(b=>({...b,boundary:"frontWall"})),boundaries:c.boundaries.slice(0,4)}).success).toBe(false);
 expect(meshKey(c)).not.toBe(meshKey(defaultPlanar));
 expect(simulationOutputs("solve",c)).toContain("geometry.bin");
 expect(pitchPoint([1,0],{...motion,meanAngleDegrees:0},.25)[1]).toBeCloseTo(Math.sin(Math.PI/18));
});
it("decodes and interpolates moving vertices without changing cell addressing",async()=>{
 const {decodeWakeGeometry,wakeGeometryAt}=await import("./simulation.ts");
 const f=WakeFields.parse({version:1,kind:"planar-flow",encoding:"float32-le",times:[1,2],centres:[[1/3,1/3]],polygons:[[[0,0],[1,0],[0,1]]],motion:{vertexCount:3,cellVertices:[[0,1,2]]},ranges:{velocity:[0,1],pressure:[0,1],vorticity:[0,1]}});
 const bytes=new ArrayBuffer(48);[0,0,1,0,0,1, 0,0,2,0,0,2].forEach((v,i)=>new DataView(bytes).setFloat32(i*4,v,true));
 const geometry=decodeWakeGeometry(bytes,f),mid=wakeGeometryAt(f,geometry,0,1,.5);
 expect(mid.polygons).toEqual([[[0,0],[1.5,0],[0,1.5]]]);expect(mid.centres).toEqual([[.5,.5]]);
 expect(()=>decodeWakeGeometry(bytes.slice(0,40),f)).toThrow(/size/);
 new DataView(bytes).setFloat32(0,Infinity,true);expect(()=>decodeWakeGeometry(bytes,f)).toThrow(/Non-finite/);
 expect(WakeFields.safeParse({...f,motion:{vertexCount:3,cellVertices:[[0,1,3]]}}).success).toBe(false);
});
