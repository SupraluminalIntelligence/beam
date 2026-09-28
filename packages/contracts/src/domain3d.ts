import { z } from "zod";
import { Model3D, QuarterTurns, placement } from "./model3d.ts";
// Homogeneous arrays keep agent tool schemas transport-compatible; TS retains the tuple.
// Up to 100 m, so a full-size car fits in a tunnel several body lengths long.
const vec3=z.array(z.number().finite().min(-100).max(100)).length(3).transform(p=>p as [number,number,number]);
// Up to 100 m/s (about Mach 0.3), where the incompressible solver still applies to air.
const velocity3=z.array(z.number().finite().min(-100).max(100)).length(3).transform(p=>p as [number,number,number]);
const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Use a short OpenFOAM identifier: letters, digits and underscores").refine(n=>!n.startsWith("body_")&&!n.startsWith("slice_"),"body_ and slice_ prefixes are reserved");
export type Point3=[number,number,number];
export const FlowBoundary3D=z.discriminatedUnion("type",[
 z.object({name,type:z.literal("velocity-inlet"),velocity:velocity3}).strict(),
 z.object({name,type:z.literal("pressure-outlet"),pressure:z.number().finite().min(-1e6).max(1e6)}).strict(),
 z.object({name,type:z.literal("wall")}).strict(),
 z.object({name,type:z.literal("symmetry")}).strict(),
]);
export const Body3D=z.discriminatedUnion("shape",[
 z.object({name,shape:z.literal("sphere"),centre:vec3,radius:z.number().min(.0001).max(5),boundary:name}).strict(),
 z.object({name,shape:z.literal("box"),min:vec3,max:vec3,boundary:name}).strict(),
 z.object({name,shape:z.literal("cylinder"),start:vec3,end:vec3,radius:z.number().min(.0001).max(5),boundary:name}).strict(),
 // Ahmed body (Ahmed, Ramm & Faltin 1984): nose is the front face at the underside, on the centreline; it points -x.
 z.object({name,shape:z.literal("ahmed"),nose:vec3,scale:z.number().min(.02).max(3),slantDegrees:z.number().min(0).max(40),boundary:name}).strict(),
 // Imported closed surface: scale converts its units to metres, rotation is quarter turns about x, y then z,
 // and position is the front-bottom-centre of the placed bounding box (min x, mid y, min z).
 z.object({name,shape:z.literal("model"),model:Model3D,scale:z.number().min(1e-5).max(1000),rotation:QuarterTurns,position:vec3,boundary:name}).strict(),
]);
export type Body3D=z.infer<typeof Body3D>;
type Ahmed=Extract<Body3D,{shape:"ahmed"}>;
export type ModelBody=Extract<Body3D,{shape:"model"}>;
/** Where a mesh job finds an imported body's stored surface. */
export const modelInputPath=(b:{name:string})=>`models/${b.name}.stl`;
/** Mesh job inputs: one stored surface per imported body, in body order. */
export const modelInputs=(c:{bodies:readonly Body3D[]})=>c.bodies.flatMap(b=>b.shape==="model"?[{assetId:b.model.assetId,path:modelInputPath(b)}]:[]);
/** Full-scale Ahmed body in metres: length, width, height, front edge radius and rear slant length. Stilts are not modelled. */
export const AHMED={length:1.044,width:.389,height:.288,radius:.1,slant:.222,groundClearance:.05} as const;
/** Cross-section at x metres behind the nose, in full-scale units: the front edges are rounded, the long edges sharp. */
function ahmedSection(slantDegrees:number,x:number){
 const {length:L,width:W,height:H,radius:R,slant}=AHMED,phi=slantDegrees*Math.PI/180,start=L-slant*Math.cos(phi);
 const d=x<R?R-Math.sqrt(Math.max(0,R*R-(R-x)**2)):0;
 return{half:W/2-d,low:d,high:(x>start?H-(x-start)*Math.tan(phi):H)-d};
}
/** Closed, outward-facing triangulated Ahmed body surface in world coordinates. */
export function ahmedSurface(b:Ahmed){
 const {length:L,radius:R,slant}=AHMED,phi=b.slantDegrees*Math.PI/180;
 const stations=[...Array.from({length:17},(_,k)=>R-R*Math.cos(k/16*Math.PI/2)),...(b.slantDegrees>0?[L-slant*Math.cos(phi)]:[]),L];
 const points:number[]=[],triangles:number[]=[];
 for(const x of stations){
  const s=ahmedSection(b.slantDegrees,x);
  // Corners counterclockwise in (y, z): bottom-left, bottom-right, top-right, top-left.
  for(const [y,z] of [[-s.half,s.low],[s.half,s.low],[s.half,s.high],[-s.half,s.high]] as const)points.push(b.nose[0]+x*b.scale,b.nose[1]+y*b.scale,b.nose[2]+z*b.scale);
 }
 for(let k=0;k+1<stations.length;k++)for(let i=0;i<4;i++){const a=4*k+i,a1=4*k+(i+1)%4,c=a+4,c1=a1+4;triangles.push(a,a1,c1,a,c1,c);}
 const last=4*(stations.length-1);
 triangles.push(0,2,1,0,3,2,last,last+1,last+2,last,last+2,last+3);
 return{points,triangles};
}
function surfaceMeasures(s:{points:number[];triangles:number[]}){
 let area=0,volume=0;const p=(i:number)=>[s.points[3*i]!,s.points[3*i+1]!,s.points[3*i+2]!] as const;
 for(let t=0;t<s.triangles.length;t+=3){
  const a=p(s.triangles[t]!),b=p(s.triangles[t+1]!),c=p(s.triangles[t+2]!),u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],w=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  const n=[u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!];
  area+=Math.hypot(n[0]!,n[1]!,n[2]!)/2;volume+=(a[0]*n[0]!+a[1]*n[1]!+a[2]*n[2]!)/6;
 }
 return{area,volume};
}
/** Projected area facing a flow along +x, the reference area for Cd and Cl. */
export function frontalArea(b:Body3D){
 if(b.shape==="sphere")return Math.PI*b.radius**2;
 if(b.shape==="box")return(b.max[1]-b.min[1])*(b.max[2]-b.min[2]);
 if(b.shape==="ahmed")return AHMED.width*AHMED.height*b.scale**2;
 if(b.shape==="model")return b.model.projectedArea[placement(b).streamwiseAxis]!*b.scale**2;
 const d=[b.end[0]-b.start[0],b.end[1]-b.start[1],b.end[2]-b.start[2]],l=Math.hypot(d[0]!,d[1]!,d[2]!),cos=Math.abs(d[0]!)/l;
 return 2*b.radius*l*Math.sqrt(1-cos*cos)+Math.PI*b.radius**2*cos;
}
const level=z.number().int().min(1).max(4);
export const Refinement3D=z.discriminatedUnion("kind",[
 z.object({name,kind:z.literal("body"),body:name,level,distance:z.number().finite().min(0).max(10)}).strict(),
 z.object({name,kind:z.literal("box"),min:vec3,max:vec3,level}).strict(),
]);
export type Refinement3D=z.infer<typeof Refinement3D>;
export const Slice3D=z.object({name,normal:z.enum(["x","y","z"]),offset:z.number().finite().min(-100).max(100)}).strict();
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
 if(b.shape==="ahmed"){const s=b.scale;return{min:[b.nose[0],b.nose[1]-AHMED.width/2*s,b.nose[2]],max:[b.nose[0]+AHMED.length*s,b.nose[1]+AHMED.width/2*s,b.nose[2]+AHMED.height*s]};}
 if(b.shape==="model"){const p=placement(b);return{min:p.min,max:p.max};}
 // Exact axis-aligned extent of a capped cylinder.
 const d=axes.map(i=>b.end[i]-b.start[i]),length=Math.hypot(...d)||1,r=axes.map(i=>b.radius*Math.sqrt(Math.max(0,1-(d[i]!/length)**2)));
 return{min:axes.map(i=>Math.min(b.start[i],b.end[i])-r[i]!) as Point3,max:axes.map(i=>Math.max(b.start[i],b.end[i])+r[i]!) as Point3};
}
export function bodyVolume(b:Body3D){if(b.shape==="model")return b.model.volume*b.scale**3;if(b.shape==="ahmed")return surfaceMeasures(ahmedSurface(b)).volume;return b.shape==="sphere"?4/3*Math.PI*b.radius**3:b.shape==="box"?axes.reduce<number>((v,i)=>v*(b.max[i]-b.min[i]),1):Math.PI*b.radius**2*Math.hypot(...axes.map(i=>b.end[i]-b.start[i]));}
export function bodyArea(b:Body3D){if(b.shape==="model")return b.model.area*b.scale**2;if(b.shape==="ahmed")return surfaceMeasures(ahmedSurface(b)).area;if(b.shape==="sphere")return 4*Math.PI*b.radius**2;if(b.shape==="box"){const [x,y,z]=axes.map(i=>b.max[i]-b.min[i]) as Point3;return 2*(x*y+y*z+x*z);}const l=Math.hypot(...axes.map(i=>b.end[i]-b.start[i]));return 2*Math.PI*b.radius*(b.radius+l);}
/** Smallest body dimension that the snapped surface must resolve. */
export function bodyThickness(b:Body3D){if(b.shape==="model")return Math.min(...axes.map(i=>b.model.max[i]-b.model.min[i]))*b.scale;if(b.shape==="ahmed")return Math.min(AHMED.width,AHMED.height)*b.scale;return b.shape==="sphere"?2*b.radius:b.shape==="box"?Math.min(...axes.map(i=>b.max[i]-b.min[i])):Math.min(2*b.radius,Math.hypot(...axes.map(i=>b.end[i]-b.start[i])));}
export function bodyLevel(c:{refinements?:Refinement3D[]|undefined},b:Body3D){return Math.max(0,...(c.refinements??[]).filter(r=>r.kind==="body"&&r.body===b.name).map(r=>r.level));}
export function backgroundCells(c:{domain:{min:Point3;max:Point3};meshSize:number}){return axes.map(i=>Math.max(1,Math.round((c.domain.max[i]-c.domain.min[i])/c.meshSize))) as Point3;}
/** Inside test; an imported model counts its whole bounding box as solid, which keeps fluid points and seeds safely outside it. */
export function insideBody(b:Body3D,p:Point3,pad=0){
 if(b.shape==="model"){const {min,max}=placement(b);return axes.every(i=>p[i]>min[i]-pad&&p[i]<max[i]+pad);}
 if(b.shape==="sphere")return Math.hypot(...axes.map(i=>p[i]-b.centre[i]))<b.radius+pad;
 if(b.shape==="box")return axes.every(i=>p[i]>b.min[i]-pad&&p[i]<b.max[i]+pad);
 if(b.shape==="ahmed"){
  const x=(p[0]-b.nose[0])/b.scale,y=(p[1]-b.nose[1])/b.scale,z=(p[2]-b.nose[2])/b.scale,q=pad/b.scale;
  if(x<=-q||x>=AHMED.length+q)return false;
  const s=ahmedSection(b.slantDegrees,Math.min(AHMED.length,Math.max(0,x)));
  return Math.abs(y)<s.half+q&&z>s.low-q&&z<s.high+q;
 }
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
  // Nested bands around the surface: the requested distance at the finest level, then snappy's
  // three buffer cells per level (nCellsBetweenLevels). Each band splits its parent cells into 8.
  const distance=(c.refinements??[]).reduce((m,r)=>r.kind==="body"&&r.body===b.name?Math.max(m,r.distance):m,0),area=bodyArea(b),r=bodyThickness(b)/2;
  for(let l=1;l<=L;l++){
   let t=distance;for(let k=l;k<=L;k++)t+=3*h/2**k;
   // Outward shell of thickness t; the curvature term keeps it an upper bound for convex bodies.
   total+=area*t*(1+t/r+t*t/(3*r*r))/cell*(8**l-8**(l-1));
  }
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
 initialVelocity:velocity3,duration:z.number().min(.001).max(100),frames:z.number().int().min(2).max(60),
 // A published drag coefficient to compare with, on its source's reference area (m²). Never used by the solve.
 reference:z.object({cd:z.number().finite().min(0).max(10),area:z.number().finite().positive().max(1000),source:z.string().min(1).max(120)}).strict().optional(),
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
  // Two cells at the body's surface level, so a car can sit close to a tunnel floor when refined.
  const size=h/2**bodyLevel(c,b);
  if(axes.some(i=>bb.min[i]<min[i]+2*size||bb.max[i]>max[i]-2*size))issue(`Body ${b.name} must lie inside the domain with two cells of clearance at its surface level`);
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
/** Ahmed body at 25° in a wind tunnel at 40 m/s, as in Lienhart and Becker (2003), without stilts. */
export const defaultAhmedTunnel:Domain3DCase={version:1,geometry:"domain3d",
 domain:{min:[-2,-1,0],max:[5.5,1,1.5],faces:{xMin:"inlet",xMax:"outlet",yMin:"tunnel",yMax:"tunnel",zMin:"ground",zMax:"tunnel"}},
 bodies:[{name:"ahmed",shape:"ahmed",nose:[0,0,AHMED.groundClearance],scale:1,slantDegrees:25,boundary:"bodyWall"}],
 boundaries:[{name:"inlet",type:"velocity-inlet",velocity:[40,0,0]},{name:"outlet",type:"pressure-outlet",pressure:0},{name:"ground",type:"wall"},{name:"tunnel",type:"symmetry"},{name:"bodyWall",type:"wall"}],
 region:{name:"air",material:"Air at 20 °C",density:1.2,nu:1.5e-5},
 turbulence:{model:"kOmegaSST",intensity:.01,lengthScale:.05},
 meshSize:.1,
 refinements:[{name:"bodySurface",kind:"body",body:"ahmed",level:3,distance:.02},{name:"near",kind:"box",min:[-.3,-.5,0],max:[3.5,.5,.7],level:1},{name:"wake",kind:"box",min:[.9,-.3,0],max:[2.2,.3,.45],level:2}],
 slices:[{name:"centreline",normal:"y",offset:0},{name:"wake",normal:"x",offset:1.3},{name:"midHeight",normal:"z",offset:.2}],
 initialVelocity:[40,0,0],duration:.3,frames:30,
};
/** Wind-tunnel drag coefficients of the Ahmed body measured by Ahmed, Ramm and Faltin (1984), by slant angle. */
export const AHMED_MEASURED_CD:Readonly<Record<number,number>>={25:.285,35:.26};
/** The measured Cd to compare against, when the study is a single Ahmed body at a measured slant. */
export function ahmedMeasuredCd(c:Domain3DCase){const b=c.bodies.length===1?c.bodies[0]!:null;return b?.shape==="ahmed"?AHMED_MEASURED_CD[b.slantDegrees]??null:null;}
/** The drag to compare a run with: the study's stated reference, or the Ahmed measurement at its slant (on the body's own frontal area). */
export function referenceDrag(c:Domain3DCase):{cd:number;area:number|null;source:string}|null{
 if(c.reference)return c.reference;
 const cd=ahmedMeasuredCd(c);return cd===null?null:{cd,area:null,source:"Ahmed 1984"};
}
/**
 * WindsorML run 1 (Ashton et al. 2024, CC BY-SA 4.0): a squareback Windsor body on four pins, y up, flow
 * along +x, at 40 m/s over a stationary no-slip ground. Its wall-modelled LES gives Cd 0.3225 on 0.112 m².
 */
export const WINDSOR={file:"windsor_1.stl",rotation:[90,0,0] as Point3,speed:40,reference:{cd:.3225,area:.112,source:"WindsorML run 1 · WMLES"}} as const;
export function windsorTunnel(model:Model3D):Domain3DCase{
 return Domain3DCase.parse({...modelWindTunnel(model,{scale:1,rotation:WINDSOR.rotation,speed:WINDSOR.speed,name:"windsor"}),reference:WINDSOR.reference});
}
/** Estimated cells a generated tunnel aims for: well inside the budget, so a solve takes minutes rather than hours. */
export const MODEL_TUNNEL_CELL_TARGET=150_000;
/**
 * A wind tunnel sized around an imported model, with flow along +x. With a ground, the model sits
 * 2.5 surface cells above a no-slip floor (touching surfaces cannot be meshed); without one, it is
 * centred in free stream. Refinement levels and the background size are the finest that fit the target.
 */
export function modelWindTunnel(model:Model3D,{scale,rotation=[0,0,0],speed=40,ground=true,name="model"}:{scale:number;rotation?:readonly number[];speed?:number;ground?:boolean;name?:string}):Domain3DCase{
 const probe:ModelBody={name,shape:"model",model:Model3D.parse(model),scale,rotation:[...rotation] as Point3,position:[0,0,0],boundary:"bodyWall"};
 const {min,max}=bodyBounds(probe),[L,W,H]=axes.map(i=>max[i]-min[i]) as Point3,S=Math.max(W,H),D=Math.max(L,S);
 const build=(h:number,surface:number,wake:number,near:number):Domain3DCase=>{
  // Four significant digits keep the setup readable; clearance and margins are generous by comparison.
  const r=(v:number)=>Number(v.toPrecision(4)),z0=ground?r(2.5*h/2**surface):r(-H/2),top=z0+H,floor=ground?0:z0;
  const band=(margin:number)=>({y:r(W/2+margin*S),lo:ground?0:r(floor-margin*S),hi:r(top+margin*S)});
  const n=band(.8),w=band(.25);
  return Domain3DCase.parse({version:1,geometry:"domain3d",
   domain:{min:[r(-2*D),r(-(W/2+2*S)),ground?0:r(floor-2*S)],max:[r(L+4*D),r(W/2+2*S),r(top+(ground?3:2)*S)],faces:{xMin:"inlet",xMax:"outlet",yMin:"tunnel",yMax:"tunnel",zMin:ground?"ground":"tunnel",zMax:"tunnel"}},
   bodies:[{...probe,position:[0,0,z0]}],
   boundaries:[{name:"inlet",type:"velocity-inlet",velocity:[speed,0,0]},{name:"outlet",type:"pressure-outlet",pressure:0},...(ground?[{name:"ground",type:"wall"}]:[]),{name:"tunnel",type:"symmetry"},{name:"bodyWall",type:"wall"}],
   region:{name:"air",material:"Air at 20 °C",density:1.2,nu:1.5e-5},
   turbulence:{model:"kOmegaSST",intensity:.01,lengthScale:Math.min(10,Math.max(1e-5,.15*Math.min(W,H)))},
   meshSize:h,
   refinements:[{name:"bodySurface",kind:"body",body:name,level:surface,distance:r(1.5*h/2**surface)},
    ...(near?[{name:"near",kind:"box",min:[r(-.3*D),-n.y,n.lo],max:[r(L+2.3*D),n.y,n.hi],level:near}]:[]),
    ...(wake?[{name:"wake",kind:"box",min:[r(.85*L),-w.y,w.lo],max:[r(L+1.2*D),w.y,w.hi],level:wake}]:[])],
   slices:[{name:"centreline",normal:"y",offset:0},{name:"wake",normal:"x",offset:r(1.25*L)},{name:"midHeight",normal:"z",offset:r(z0+H/2)}],
   initialVelocity:[speed,0,0],duration:Math.min(100,Math.max(.001,Number((10*L/speed).toPrecision(2)))),frames:30,
  });
 };
 const span=[L+6*D,W+4*S,H+(ground?3:4)*S],start=Math.cbrt(span.reduce((v,x)=>v*x,1)/40_000);
 let best:{config:Domain3DCase;cell:number}|null=null;
 for(const [surface,wake,near] of [[3,2,1],[3,1,1],[2,1,1],[2,0,1],[2,0,0],[1,0,0]] as const){
  for(let k=0;k<40;k++){
   const h=Number((start*1.1**k).toPrecision(3));
   let config:Domain3DCase;try{config=build(h,surface,wake,near);}catch{continue;}
   if(estimateDomain3dCells(config).estimated>MODEL_TUNNEL_CELL_TARGET)continue;
   if(!best||h/2**surface<best.cell)best={config,cell:h/2**surface};
   break;
  }
 }
 if(!best)throw new Error(`No tunnel around this ${fmtSize(L,W,H)} model fits the local 3D budget. Check its units: a very large or very thin model needs scaling, and a tunnel must stay within ±100 m`);
 return best.config;
}
const fmtSize=(...d:number[])=>d.map(v=>Number(v.toPrecision(3))).join(" × ")+" m";
