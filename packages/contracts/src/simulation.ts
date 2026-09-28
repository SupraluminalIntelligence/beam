import { z } from "zod";
import { PlanarCase } from "./planar.ts";
import { ParallelChannelsCase, ParallelChannelsResults, parallelSetupChecks } from "./parallelChannels.ts";
import { channelSetupChecks } from "./channelChecks.ts";
import { Domain3DCase, modelInputs } from "./domain3d.ts";
export * from "./planar.ts";
export * from "./parallelChannels.ts";
export * from "./channelChecks.ts";
export * from "./meshStudy.ts";
export * from "./domain3d.ts";
export * from "./model3d.ts";

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
  // Stated fluid data for setup checks only; the solve keeps gravity off and never boils.
  beta: z.number().min(0).max(0.02).optional(), boilingPoint: z.number().min(100).max(1000).optional(),
  // Uniform heat flux into the fluid through both walls (W/m²), in place of wallTemperature; converting it to a wall gradient needs the conductivity (W/m·K).
  wallHeatFlux: z.number().positive().max(1e7).optional(), conductivity: z.number().min(0.01).max(500).optional(),
}).strict().superRefine((c,ctx)=>{
  if(c.wallHeatFlux!==undefined&&!c.thermal) ctx.addIssue({code:"custom",path:["wallHeatFlux"],message:"A wall heat flux needs heated walls; set thermal to true"});
  if(c.wallHeatFlux!==undefined&&c.conductivity===undefined) ctx.addIssue({code:"custom",path:["conductivity"],message:"Set the fluid's thermal conductivity to apply a wall heat flux"});
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
export const SimulationCase = z.union([ChannelCase,CylinderCase,PlanarCase,ParallelChannelsCase,Domain3DCase]);
export type SimulationCase = z.infer<typeof SimulationCase>;
/** Assumption checks for studies that have them: the heated channel and parallel channels. */
export const studySetupChecks = (c: SimulationCase) => c.geometry === "channel" ? channelSetupChecks(c) : c.geometry === "parallel-channels" ? parallelSetupChecks(c) : null;
/** Convex transports reorder object keys. Mesh identity must not depend on that order. */
export function canonicalMeshKey(key:string):string {
 const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v!==null&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,value])=>[k,stable(value)])):v;
 return JSON.stringify(stable(JSON.parse(key)));
}
export const meshKey = (c: SimulationCase) => canonicalMeshKey(JSON.stringify(c.geometry==="domain3d"?[c.geometry,"snappy-1",c.domain,c.bodies,c.meshSize,c.refinements??[],c.boundaries.map(b=>[b.name,b.type==="symmetry"?"symmetry":b.type==="wall"?"wall":"patch"])]:c.geometry==="planar"?[c.geometry,c.domain,c.bodies,c.meshSize,c.boundaries.map(b=>[b.name,b.type==="symmetry"?"symmetry":b.type==="wall"?"wall":"patch"]),...(c.refinements?.length?["refined-planar-1",c.refinements]:[]),...(c.motion?["pitch-mesh-1",c.motion]:[])]:c.geometry==="channel"?[c.geometry,c.length,c.height,c.nx,c.ny]:c.geometry==="parallel-channels"?[c.geometry,c.channelLength,c.channelHeight,c.wallThickness,c.manifoldLength,c.channels.length,c.cellsAcross,c.cellsAlong]:[c.geometry,c.diameter,c.version===1?"wake-grid-1":"wake-grid-2"]));
export const SimulationJob = z.object({image:z.literal(OPENFOAM_IMAGE).default(OPENFOAM_IMAGE),caseId:z.string().min(1),revision:z.number().int().positive(),stage:z.enum(["mesh","solve"]),config:SimulationCase,meshJobId:z.string().optional()}).strict();
export type SimulationJob = z.infer<typeof SimulationJob>;
/** 3-D polyMesh snapshots are binary archives; 2-D snapshots remain inline JSON. */
export const meshAssetPath = (config?:SimulationCase) => config?.geometry==="domain3d" ? "mesh.tar.gz" : "mesh.json";
/** Mesh jobs read the stored surface of each imported body; other studies mesh from their settings alone. */
export const simulationMeshInputs = (config:SimulationCase) => config.geometry==="domain3d" ? modelInputs(config) : [];
export const meshInputPath = (config?:SimulationCase) => config?.geometry==="domain3d" ? "mesh-input.tar.gz" : "mesh-input.json";
export const simulationOutputs = (stage: "mesh"|"solve",config?:SimulationCase) => config?.geometry==="domain3d" ? (stage==="mesh" ? ["report.json","mesh.tar.gz","mesh-view.json"] : ["report.json","fields.json","frames.bin","case.tar.gz"]) : stage === "mesh" ? ["report.json","mesh.json",...(config?.geometry==="planar"?["mesh-view.json"]:[])] : ["report.json","fields.json","case.tar.gz",...(config && config.geometry!=="channel" && config.geometry!=="parallel-channels"?["frames.bin",...(config.geometry==="planar"&&config.motion?["geometry.bin"]:[])]:[])];
/** Where a study run in the cfd environment puts the files simulationOutputs lists, under the job's results. */
export const RECIPE_OUTPUTS = "beam/out/recipe";
/** A study job's output by its name: at the top level for older jobs, under RECIPE_OUTPUTS for environment jobs. */
export const studyOutput = <T extends { path: string }>(outputs: readonly T[], name: string): T | undefined =>
  outputs.find(o => o.path === name) ?? outputs.find(o => o.path === `${RECIPE_OUTPUTS}/${name}`);
/** Heated-channel results a thermal engineer reads: flow-weighted outlet temperature, discrete energy balance, developed f·Re and local Nu(x) on 2H. */
export const ChannelResults = z.object({bulkOutletTemperatureK:z.number().finite(),maxWallTemperatureK:z.number().finite().optional(),energyImbalance:z.number().finite().nullable(),fRe:z.number().finite().nullable(),nusselt:z.array(z.tuple([z.number().finite(),z.number().finite()])).max(160)});
export type ChannelResults = z.infer<typeof ChannelResults>;
/** Body forces from OpenFOAM's forces function object, averaged over the second half of the run. Coefficients need flow along +x. */
export const Domain3DForces=z.object({patches:z.array(z.string()).min(1).max(20),speed:z.number().positive(),referenceArea:z.number().positive(),referenceLength:z.number().positive(),averagedFrom:z.number().finite(),forceN:z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]),cd:z.number().finite().nullable(),cl:z.number().finite().nullable(),history:z.array(z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])).max(400)});
export type Domain3DForces=z.infer<typeof Domain3DForces>;
export const SimulationReport = z.object({version:z.literal(1),stage:z.enum(["mesh","solve"]),config:SimulationCase,image:z.string(),cells:z.number().int().positive(),meshOk:z.boolean(),maxNonOrthogonality:z.number().nullable(),maxSkewness:z.number().nullable(),iterations:z.number().int().nonnegative(),converged:z.boolean(),residuals:z.array(z.object({iteration:z.number(),field:z.string(),initial:z.number(),final:z.number()})).max(30000),massImbalance:z.number().nullable(),pressureDropPa:z.number().nullable(),outletTemperatureK:z.number().nullable(),thermalBalance:z.literal("not-evaluated"),meshSensitivity:z.literal("not-studied"),physicalTime:z.number().finite().optional(),maxCourant:z.number().finite().optional(),motion:z.object({checkedFrames:z.number().int().positive(),minCellAreaM2:z.number().positive().finite()}).optional(),channel:ChannelResults.optional(),parallel:ParallelChannelsResults.optional(),domain3d:z.object({backgroundCells:z.number().int().positive(),estimatedCells:z.number().int().nonnegative(),cellTypes:z.record(z.string(),z.number().int().nonnegative()),geometryChecks:z.string().max(400),turbulence:z.string(),processes:z.number().int().positive(),requestedFrames:z.number().int().nonnegative(),savedFrames:z.number().int().nonnegative(),archive:z.enum(["final-fields","dictionaries-only","none"]),maxNutRatio:z.number().finite().nullable(),forces:Domain3DForces.optional()}).optional()});
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

/** Sampled 3-D surfaces: slices and body walls with fixed topology across saved times. */
const Surface3D=z.object({name:z.string().min(1).max(60),kind:z.enum(["slice","wall"]),points:z.array(z.number().finite()).max(600000),triangles:z.array(z.number().int().nonnegative()).max(1200000)}).superRefine((s,ctx)=>{if(s.points.length%3||s.triangles.length%3||s.triangles.some(i=>i*3>=s.points.length))ctx.addIssue({code:"custom",message:"Invalid surface addressing"});});
export type Surface3D=z.infer<typeof Surface3D>;
/** Streamlines traced through the final velocity field: flat [x, y, z] points with the speed at each. */
const Streamline3D=z.object({points:z.array(z.number().finite()).max(900),speed:z.array(z.number().finite()).max(300)}).superRefine((l,ctx)=>{if(l.points.length%3||l.points.length/3!==l.speed.length||l.speed.length<2)ctx.addIssue({code:"custom",message:"Invalid streamline"});});
export const Domain3DStreamlines=z.object({time:z.number().finite(),lines:z.array(Streamline3D).max(160),range:z.tuple([z.number().finite(),z.number().finite()])});
export type Domain3DStreamlines=z.infer<typeof Domain3DStreamlines>;
/** Float32 little-endian, frame-major, then surface order, then point-major [Ux, Uy, Uz, p in Pa]. */
export const Domain3DFields=z.object({
 version:z.literal(1),kind:z.literal("domain3d-surfaces"),encoding:z.literal("float32-le"),
 times:z.array(z.number().finite().positive()).min(1).max(60),
 surfaces:z.array(Surface3D).min(1).max(12),
 ranges:z.object({velocity:z.tuple([z.number().finite(),z.number().finite()]),pressure:z.tuple([z.number().finite(),z.number().finite()])}),
 streamlines:Domain3DStreamlines.optional(),
}).superRefine((f,ctx)=>{if(f.times.some((t,i)=>i>0&&t<=f.times[i-1]!))ctx.addIssue({code:"custom",message:"Invalid time sequence"});});
export type Domain3DFields=z.infer<typeof Domain3DFields>;
export const domain3dPoints=(f:Pick<Domain3DFields,"surfaces">)=>f.surfaces.reduce((n,s)=>n+s.points.length/3,0);
export function decodeDomain3dFrames(bytes:ArrayBuffer,fields:Domain3DFields):Float32Array{
 const count=fields.times.length*domain3dPoints(fields)*4;
 if(bytes.byteLength!==count*4||bytes.byteLength>20e6)throw new Error("3D frame size does not match its manifest");
 const view=new DataView(bytes),values=new Float32Array(count);
 for(let i=0;i<count;i++){const v=view.getFloat32(i*4,true);if(!Number.isFinite(v))throw new Error("Non-finite 3D field");values[i]=v;}
 return values;
}
/** Actual snapped wall surfaces and the mesh cut by each slice plane (polygon faces). */
export const Domain3DMeshView=z.object({version:z.literal(1),kind:z.literal("domain3d-mesh"),surfaces:z.array(z.object({name:z.string().min(1).max(60),kind:z.enum(["slice","wall"]),points:z.array(z.number().finite()).max(600000),counts:z.array(z.number().int().min(3).max(64)).max(200000),indices:z.array(z.number().int().nonnegative()).max(1200000)}).superRefine((s,ctx)=>{if(s.points.length%3||s.counts.reduce((a,b)=>a+b,0)!==s.indices.length||s.indices.some(i=>i*3>=s.points.length))ctx.addIssue({code:"custom",message:"Invalid mesh view addressing"});})).max(12)});
export type Domain3DMeshView=z.infer<typeof Domain3DMeshView>;
