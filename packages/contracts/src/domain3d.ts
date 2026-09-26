import { z } from "zod";
// Homogeneous arrays keep agent tool schemas transport-compatible; TS retains the tuple.
const vec3=z.array(z.number().finite().min(-10).max(10)).length(3).transform(p=>p as [number,number,number]);
const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Use a short OpenFOAM identifier: letters, digits and underscores").refine(n=>!n.startsWith("body_")&&!n.startsWith("slice_"),"body_ and slice_ prefixes are reserved");
export type Point3=[number,number,number];
export const FlowBoundary3D=z.discriminatedUnion("type",[
 z.object({name,type:z.literal("velocity-inlet"),velocity:vec3}).strict(),
 z.object({name,type:z.literal("pressure-outlet"),pressure:z.number().finite().min(-1e6).max(1e6)}).strict(),
 z.object({name,type:z.literal("wall")}).strict(),
 z.object({name,type:z.literal("symmetry")}).strict(),
]);
export const Body3D=z.discriminatedUnion("shape",[
 z.object({name,shape:z.literal("sphere"),centre:vec3,radius:z.number().min(.0001).max(5),boundary:name}).strict(),
 z.object({name,shape:z.literal("box"),min:vec3,max:vec3,boundary:name}).strict(),
 z.object({name,shape:z.literal("cylinder"),start:vec3,end:vec3,radius:z.number().min(.0001).max(5),boundary:name}).strict(),
]);
export type Body3D=z.infer<typeof Body3D>;
const level=z.number().int().min(1).max(4);
export const Refinement3D=z.discriminatedUnion("kind",[
 z.object({name,kind:z.literal("body"),body:name,level,distance:z.number().finite().min(0).max(10)}).strict(),
 z.object({name,kind:z.literal("box"),min:vec3,max:vec3,level}).strict(),
]);
export type Refinement3D=z.infer<typeof Refinement3D>;
export const Slice3D=z.object({name,normal:z.enum(["x","y","z"]),offset:z.number().finite().min(-10).max(10)}).strict();
export type Slice3D=z.infer<typeof Slice3D>;
export const Turbulence3D=z.discriminatedUnion("model",[
 z.object({model:z.literal("laminar")}).strict(),
 // Inlet k = 1.5 (U I)^2 and omega = sqrt(k) / (Cmu^0.25 L); both are also the initial field.
 z.object({model:z.literal("kOmegaSST"),intensity:z.number().min(.001).max(.3),lengthScale:z.number().min(1e-5).max(10)}).strict(),
]);
const faces=z.object({xMin:name,xMax:name,yMin:name,yMax:name,zMin:name,zMax:name}).strict();
export const DOMAIN3D_CELL_BUDGET=250_000;
export const DOMAIN3D_BACKGROUND_BUDGET=120_000;
const axes=[0,1,2] as const;
export function bodyBounds(b:Body3D):{min:Point3;max:Point3}{
 if(b.shape==="sphere")return{min:b.centre.map(v=>v-b.radius) as Point3,max:b.centre.map(v=>v+b.radius) as Point3};
 if(b.shape==="box")return{min:b.min,max:b.max};
 // Exact axis-aligned extent of a capped cylinder.
 const d=axes.map(i=>b.end[i]-b.start[i]),length=Math.hypot(...d)||1,r=axes.map(i=>b.radius*Math.sqrt(Math.max(0,1-(d[i]!/length)**2)));
 return{min:axes.map(i=>Math.min(b.start[i],b.end[i])-r[i]!) as Point3,max:axes.map(i=>Math.max(b.start[i],b.end[i])+r[i]!) as Point3};
}
export function bodyVolume(b:Body3D){return b.shape==="sphere"?4/3*Math.PI*b.radius**3:b.shape==="box"?axes.reduce<number>((v,i)=>v*(b.max[i]-b.min[i]),1):Math.PI*b.radius**2*Math.hypot(...axes.map(i=>b.end[i]-b.start[i]));}
export function bodyArea(b:Body3D){if(b.shape==="sphere")return 4*Math.PI*b.radius**2;if(b.shape==="box"){const [x,y,z]=axes.map(i=>b.max[i]-b.min[i]) as Point3;return 2*(x*y+y*z+x*z);}const l=Math.hypot(...axes.map(i=>b.end[i]-b.start[i]));return 2*Math.PI*b.radius*(b.radius+l);}
/** Smallest body dimension that the snapped surface must resolve. */
export function bodyThickness(b:Body3D){return b.shape==="sphere"?2*b.radius:b.shape==="box"?Math.min(...axes.map(i=>b.max[i]-b.min[i])):Math.min(2*b.radius,Math.hypot(...axes.map(i=>b.end[i]-b.start[i])));}
export function bodyLevel(c:{refinements?:Refinement3D[]|undefined},b:Body3D){return Math.max(0,...(c.refinements??[]).filter(r=>r.kind==="body"&&r.body===b.name).map(r=>r.level));}
export function backgroundCells(c:{domain:{min:Point3;max:Point3};meshSize:number}){return axes.map(i=>Math.max(1,Math.round((c.domain.max[i]-c.domain.min[i])/c.meshSize))) as Point3;}
export function insideBody(b:Body3D,p:Point3,pad=0){
 if(b.shape==="sphere")return Math.hypot(...axes.map(i=>p[i]-b.centre[i]))<b.radius+pad;
 if(b.shape==="box")return axes.every(i=>p[i]>b.min[i]-pad&&p[i]<b.max[i]+pad);
 const d=axes.map(i=>b.end[i]-b.start[i]),l2=d.reduce((s,v)=>s+v*v,0),t=axes.reduce<number>((s,i)=>s+(p[i]-b.start[i])*d[i]!,0)/l2;
 if(t<-pad/Math.sqrt(l2)||t>1+pad/Math.sqrt(l2))return false;
 return Math.hypot(...axes.map(i=>p[i]-b.start[i]-t*d[i]!))<b.radius+pad;
}
/**
 * Conservative pre-mesh estimate. Refined regions are counted independently (overlaps double count),
 * so this is an upper-bound guide; the runner enforces the actual snappyHexMesh count.
 */
export function estimateDomain3dCells(c:Domain3DCase){
 const h=c.meshSize,[nx,ny,nz]=backgroundCells(c),background=nx*ny*nz,cell=h**3;
 const clip=(min:Point3,max:Point3)=>axes.reduce<number>((v,i)=>v*Math.max(0,Math.min(max[i],c.domain.max[i])-Math.max(min[i],c.domain.min[i])),1);
 let total=background-c.bodies.reduce((s,b)=>s+bodyVolume(b),0)/cell;
 for(const b of c.bodies){
  const L=bodyLevel(c,b);if(!L)continue;
  // Surface refinement shell: requested distance plus snappy's buffer layers (3 cells per level).
  const shell=bodyArea(b)*((c.refinements??[]).reduce((m,r)=>r.kind==="body"&&r.body===b.name?Math.max(m,r.distance):m,0)+3*h*(1-.5**L)*2);
  total+=shell/cell*(8**L-1);
 }
 for(const r of c.refinements??[])if(r.kind==="box")total+=clip(r.min,r.max)/cell*(8**r.level-1);
 return{background,estimated:Math.round(total)};
}
export const Domain3DCase=z.object({
 version:z.literal(1),geometry:z.literal("domain3d"),
 domain:z.object({min:vec3,max:vec3,faces}).strict(),
 bodies:z.array(Body3D).max(8),boundaries:z.array(FlowBoundary3D).min(2).max(20),
 region:z.object({name,material:z.string().min(1).max(80),density:z.number().min(.1).max(20000),nu:z.number().min(1e-8).max(.01)}).strict(),
 turbulence:Turbulence3D,
 meshSize:z.number().min(.0001).max(1),
 refinements:z.array(Refinement3D).max(16).optional(),
 slices:z.array(Slice3D).min(1).max(3),
 initialVelocity:vec3,duration:z.number().min(.001).max(100),frames:z.number().int().min(2).max(60),
}).strict().superRefine((c,ctx)=>{
 const errors=new Set<string>();
 const issue=(message:string)=>{if(!errors.has(message)){errors.add(message);ctx.addIssue({code:"custom",message});}};
 const {min,max}=c.domain,h=c.meshSize,faceNames=Object.values(c.domain.faces);
 if(axes.some(i=>max[i]-min[i]<4*h))issue("Domain must span at least four background cells on every axis");
 const names=c.boundaries.map(b=>b.name),used=[...faceNames,...c.bodies.map(b=>b.boundary)];
 if(new Set(names).size!==names.length||new Set(c.bodies.map(b=>b.name)).size!==c.bodies.length)issue("Boundary and body names must be unique");
 if(used.some(n=>!names.includes(n))||names.some(n=>!used.includes(n)))issue("Boundary definitions must exactly cover the six domain faces and body surfaces");
 if(!c.boundaries.some(b=>b.type==="velocity-inlet")||!c.boundaries.some(b=>b.type==="pressure-outlet"))issue("Define at least one velocity inlet and pressure outlet");
 if(c.bodies.some(b=>c.boundaries.find(p=>p.name===b.boundary)?.type!=="wall"))issue("Bodies need no-slip wall boundaries");
 if(c.bodies.some(b=>faceNames.includes(b.boundary)))issue("Body walls need boundaries separate from the domain faces");
 for(const b of c.bodies){
  const bb=bodyBounds(b);
  if(b.shape==="box"&&axes.some(i=>b.min[i]>=b.max[i]))issue(`Body ${b.name}: box min must be smaller than max on every axis`);
  if(b.shape==="cylinder"&&Math.hypot(...axes.map(i=>b.end[i]-b.start[i]))<1e-6)issue(`Body ${b.name}: cylinder start and end must differ`);
  if(axes.some(i=>bb.min[i]<min[i]+2*h||bb.max[i]>max[i]-2*h))issue(`Body ${b.name} must lie inside the domain with two background cells of clearance`);
  const size=h/2**bodyLevel(c,b);
  if(bodyThickness(b)<4*size)issue(`Body ${b.name} spans fewer than four cells at its surface; add a body refinement level or reduce meshSize`);
 }
 for(let i=0;i<c.bodies.length;i++)for(let j=0;j<i;j++){
  const a=bodyBounds(c.bodies[i]!),b=bodyBounds(c.bodies[j]!);
  if(axes.every(k=>a.min[k]<b.max[k]+h&&b.min[k]<a.max[k]+h))issue(`Bodies ${c.bodies[j]!.name} and ${c.bodies[i]!.name} must be separated by at least one background cell (bounding boxes)`);
 }
 const refinements=c.refinements??[];
 if(new Set(refinements.map(r=>r.name)).size!==refinements.length)issue("Refinement names must be unique");
 for(const r of refinements){
  if(r.kind==="body"&&!c.bodies.some(b=>b.name===r.body))issue("Refinement refers to an unknown body");
  if(r.kind==="box"&&axes.some(i=>r.min[i]>=r.max[i]))issue("Refinement box min must be smaller than max on every axis");
  if(r.kind==="box"&&axes.some(i=>r.max[i]<=min[i]||r.min[i]>=max[i]))issue("Refinement box must intersect the domain");
 }
 const axis={x:0,y:1,z:2} as const;
 if(new Set(c.slices.map(s=>s.name)).size!==c.slices.length)issue("Slice names must be unique");
 for(const s of c.slices){const i=axis[s.normal];if(s.offset<=min[i]||s.offset>=max[i])issue(`Slice ${s.name} must lie strictly inside the domain`);}
 if(errors.size)return;
 const {background,estimated}=estimateDomain3dCells(c as Domain3DCase);
 if(background>DOMAIN3D_BACKGROUND_BUDGET)issue(`Background mesh has ${background} cells; the local limit is ${DOMAIN3D_BACKGROUND_BUDGET}. Increase meshSize`);
 else if(estimated>DOMAIN3D_CELL_BUDGET)issue(`Estimated ${estimated} cells after refinement exceeds the local ${DOMAIN3D_CELL_BUDGET}-cell budget; lower refinement levels or extents`);
});
export type Domain3DCase=z.infer<typeof Domain3DCase>;
/** A point in the fluid, away from every body and grid-aligned face, for snappyHexMesh. */
export function locationInMesh(c:Domain3DCase):Point3{
 const h=c.meshSize;
 for(let k=0;k<64;k++){
  const f=[.137+.071*k,.311+.053*k,.173+.089*k].map(v=>(v%.8)+.1);
  const p=axes.map(i=>c.domain.min[i]+(c.domain.max[i]-c.domain.min[i])*f[i]!) as Point3;
  // Offset from background grid faces so the point is unambiguously inside one cell.
  const q=axes.map(i=>{const n=Math.floor((p[i]-c.domain.min[i])/h);return c.domain.min[i]+(n+.5123)*h;}) as Point3;
  if(!c.bodies.some(b=>insideBody(b,q,h)))return q;
 }
 throw new Error("Cannot find a fluid point outside every body; enlarge the domain");
}
export const defaultDomain3d:Domain3DCase={version:1,geometry:"domain3d",
 domain:{min:[-.1,-.1,-.1],max:[.5,.1,.1],faces:{xMin:"inlet",xMax:"outlet",yMin:"sides",yMax:"sides",zMin:"sides",zMax:"sides"}},
 bodies:[{name:"sphere",shape:"sphere",centre:[0,0,0],radius:.02,boundary:"sphereWall"}],
 boundaries:[{name:"inlet",type:"velocity-inlet",velocity:[.5,0,0]},{name:"outlet",type:"pressure-outlet",pressure:0},{name:"sides",type:"symmetry"},{name:"sphereWall",type:"wall"}],
 region:{name:"fluid",material:"Constant-property fluid",density:1000,nu:1e-5},
 turbulence:{model:"kOmegaSST",intensity:.02,lengthScale:.004},
 meshSize:.01,
 refinements:[{name:"sphereSurface",kind:"body",body:"sphere",level:2,distance:.01},{name:"wake",kind:"box",min:[-.04,-.04,-.04],max:[.3,.04,.04],level:1}],
 slices:[{name:"midZ",normal:"z",offset:0},{name:"midY",normal:"y",offset:0}],
 initialVelocity:[.5,0,0],duration:2,frames:40,
};
