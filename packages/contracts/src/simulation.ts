import { z } from "zod";
import { PlanarCase } from "./planar.ts";
export * from "./planar.ts";

export const OPENFOAM_IMAGE = "opencfd/openfoam-default:2512@sha256:33fb575aa9980d2bc42fd58c75ae698c489293ba30c991380fe3f899c622f319";
/** First supported study: a 2-D laminar channel, prescribed wall temperature, no buoyancy. SI units. */
export const ChannelCase = z.object({
  version: z.literal(1), geometry: z.literal("channel"),
  length: z.number().min(0.01).max(2), height: z.number().min(0.001).max(0.1),
  nx: z.number().int().min(10).max(160), ny: z.number().int().min(6).max(80),
  velocity: z.number().positive().max(2), nu: z.number().min(1e-8).max(0.01),
  pr: z.number().min(0.01).max(1000), density: z.number().min(0.1).max(20000),
  inletTemperature: z.number().min(273.15).max(373.15), wallTemperature: z.number().min(273.15).max(373.15),
  thermal: z.boolean(), iterations: z.number().int().min(100).max(3000),
}).strict().superRefine((c,ctx)=>{
  if(c.length < c.height * 2) ctx.addIssue({code:"custom",message:"Channel length must be at least twice its height"});
  if(c.velocity * 2*c.height / c.nu > 1500) ctx.addIssue({code:"custom",message:"This laminar example supports Reynolds numbers up to 1500 (based on twice the channel height)"});
});
export type ChannelCase = z.infer<typeof ChannelCase>;
export const defaultChannel: ChannelCase = {version:1,geometry:"channel",length:0.2,height:0.01,nx:60,ny:20,velocity:0.02,nu:1e-6,pr:7,density:998,inletTemperature:293.15,wallTemperature:313.15,thermal:true,iterations:800};
/** Bounded, isothermal 2-D cylinder wake demonstration. SI units; Re based on diameter. */
export const CylinderCase = z.object({
  version:z.union([z.literal(1),z.literal(2)]), geometry:z.literal("cylinder"),
  diameter:z.number().min(.001).max(.1), velocity:z.number().min(.01).max(2),
  reynolds:z.number().min(60).max(180), density:z.number().min(.1).max(20000),
  duration:z.number().min(40).max(140), // advective units D/U
}).strict();
export type CylinderCase = z.infer<typeof CylinderCase>;
export const defaultCylinder:CylinderCase = {version:2,geometry:"cylinder",diameter:.01,velocity:.1,reynolds:150,density:1000,duration:100};
export const SimulationCase = z.union([ChannelCase,CylinderCase,PlanarCase]);
export type SimulationCase = z.infer<typeof SimulationCase>;
/** Convex transports reorder object keys. Mesh identity must not depend on that order. */
export function canonicalMeshKey(key:string):string {
 const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v!==null&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,value])=>[k,stable(value)])):v;
 return JSON.stringify(stable(JSON.parse(key)));
}
export const meshKey = (c: SimulationCase) => canonicalMeshKey(JSON.stringify(c.geometry==="planar"?[c.geometry,c.domain,c.bodies,c.meshSize,c.boundaries.map(b=>[b.name,b.type==="symmetry"?"symmetry":b.type==="wall"?"wall":"patch"]),...(c.refinements?.length?["refined-planar-1",c.refinements]:[]),...(c.motion?["pitch-mesh-1",c.motion]:[])]:c.geometry==="channel"?[c.geometry,c.length,c.height,c.nx,c.ny]:[c.geometry,c.diameter,c.version===1?"wake-grid-1":"wake-grid-2"]));
export const SimulationJob = z.object({image:z.literal(OPENFOAM_IMAGE).default(OPENFOAM_IMAGE),caseId:z.string().min(1),revision:z.number().int().positive(),stage:z.enum(["mesh","solve"]),config:SimulationCase,meshJobId:z.string().optional()}).strict();
export type SimulationJob = z.infer<typeof SimulationJob>;
export const simulationOutputs = (stage: "mesh"|"solve",config?:SimulationCase) => stage === "mesh" ? ["report.json","mesh.json",...(config?.geometry==="planar"?["mesh-view.json"]:[])] : ["report.json","fields.json","case.tar.gz",...(config && config.geometry!=="channel"?["frames.bin",...(config.geometry==="planar"&&config.motion?["geometry.bin"]:[])]:[])];
export const SimulationReport = z.object({version:z.literal(1),stage:z.enum(["mesh","solve"]),config:SimulationCase,image:z.string(),cells:z.number().int().positive(),meshOk:z.boolean(),maxNonOrthogonality:z.number().nullable(),maxSkewness:z.number().nullable(),iterations:z.number().int().nonnegative(),converged:z.boolean(),residuals:z.array(z.object({iteration:z.number(),field:z.string(),initial:z.number(),final:z.number()})).max(30000),massImbalance:z.number().nullable(),pressureDropPa:z.number().nullable(),outletTemperatureK:z.number().nullable(),thermalBalance:z.literal("not-evaluated"),meshSensitivity:z.literal("not-studied"),physicalTime:z.number().finite().optional(),maxCourant:z.number().finite().optional(),motion:z.object({checkedFrames:z.number().int().positive(),minCellAreaM2:z.number().positive().finite()}).optional()});
export type SimulationReport = z.infer<typeof SimulationReport>;
export const SimulationFields = z.object({version:z.literal(1),centres:z.array(z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])).max(12800),velocity:z.array(z.number().finite()).max(12800),pressure:z.array(z.number().finite()).max(12800),temperature:z.array(z.number().finite()).max(12800)}).superRefine((f,ctx)=>{if(!f.centres.length||[f.velocity,f.pressure,f.temperature].some(a=>a.length!==f.centres.length))ctx.addIssue({code:"custom",message:"Field and cell counts differ"});});
export type SimulationFields = z.infer<typeof SimulationFields>;
/** Float32 little-endian, frame-major, cell-major [Ux, Uy, p in Pa, omega-z in 1/s]. */
export const WakeFields = z.object({
 version:z.literal(1),kind:z.enum(["cylinder-wake","planar-flow"]),encoding:z.literal("float32-le"),
 times:z.array(z.number().finite().positive()).min(2).max(120),
 centres:z.array(z.tuple([z.number().finite(),z.number().finite()])).min(1).max(12800),
 polygons:z.array(z.array(z.tuple([z.number().finite(),z.number().finite()])).min(3).max(8)).max(12800),
 motion:z.object({vertexCount:z.number().int().min(3).max(6500),cellVertices:z.array(z.array(z.number().int().nonnegative()).length(3)).min(1).max(12000)}).optional(),
 ranges:z.object({velocity:z.tuple([z.number().finite(),z.number().finite()]),pressure:z.tuple([z.number().finite(),z.number().finite()]),vorticity:z.tuple([z.number().finite(),z.number().finite()])}),
}).superRefine((f,ctx)=>{if(f.motion&&(f.motion.cellVertices.length!==f.centres.length||f.motion.cellVertices.some(p=>p.some(i=>i>=f.motion!.vertexCount))))ctx.addIssue({code:"custom",message:"Invalid moving mesh addressing"});if(f.polygons.length!==f.centres.length||f.times.some((t,i)=>i>0&&t<=f.times[i-1]!))ctx.addIssue({code:"custom",message:"Invalid wake mesh or time sequence"});});
export type WakeFields=z.infer<typeof WakeFields>;
export function decodeWakeFrames(bytes:ArrayBuffer,fields:WakeFields):Float32Array{
 const count=fields.times.length*fields.centres.length*4;
 if(bytes.byteLength!==count*4||bytes.byteLength>20e6)throw new Error("Wake frame size does not match its manifest");
 const view=new DataView(bytes),values=new Float32Array(count);
 for(let i=0;i<count;i++){const v=view.getFloat32(i*4,true);if(!Number.isFinite(v))throw new Error("Non-finite wake field");values[i]=v;}
 return values;
}

export const PlanarMeshView=z.object({version:z.literal(1),polygons:z.array(z.array(z.tuple([z.number().finite(),z.number().finite()])).min(3).max(8)).min(1).max(12000)});
export type PlanarMeshView=z.infer<typeof PlanarMeshView>;

export function decodeWakeGeometry(bytes:ArrayBuffer,fields:WakeFields):Float32Array{
 if(!fields.motion||bytes.byteLength!==fields.times.length*fields.motion.vertexCount*8||bytes.byteLength>20e6)throw new Error("Moving mesh size does not match its manifest");
 const view=new DataView(bytes),result=new Float32Array(bytes.byteLength/4);
 for(let i=0;i<result.length;i++){const v=view.getFloat32(i*4,true);if(!Number.isFinite(v))throw new Error("Non-finite moving mesh coordinate");result[i]=v;}return result;
}
export function wakeGeometryAt(fields:WakeFields,geometry:Float32Array,lo:number,hi:number,blend:number){
 if(!fields.motion)throw new Error("Missing moving mesh topology");
 const n=fields.motion.vertexCount,positions=new Float32Array(n*2);
 for(let i=0;i<positions.length;i++)positions[i]=geometry[lo*n*2+i]!*(1-blend)+geometry[hi*n*2+i]!*blend;
 const polygons=fields.motion.cellVertices.map(p=>p.map(i=>[positions[i*2]!,positions[i*2+1]!] as [number,number]));
 const centres=polygons.map(p=>[p.reduce((s,v)=>s+v[0],0)/3,p.reduce((s,v)=>s+v[1],0)/3] as [number,number]);
 return{positions,polygons,centres};
}
