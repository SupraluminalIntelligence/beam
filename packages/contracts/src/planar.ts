import { z } from "zod";
// Homogeneous array schemas are accepted by both agent tool transports; retain a tuple in TS.
const point=z.array(z.number().finite().min(-10).max(10)).length(2).transform(p=>p as [number,number]);
const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Use a short OpenFOAM identifier: letters, digits and underscores").refine(n=>n!=="frontAndBack","frontAndBack is reserved");
const polygon=z.array(point).min(3).max(80);
export const FlowBoundary=z.discriminatedUnion("type",[
 z.object({name,type:z.literal("velocity-inlet"),velocity:point}).strict(),
 z.object({name,type:z.literal("pressure-outlet"),pressure:z.number().finite().min(-1e6).max(1e6)}).strict(),
 z.object({name,type:z.literal("wall")}).strict(),
 z.object({name,type:z.literal("symmetry")}).strict(),
]);
export const FlowBody=z.discriminatedUnion("shape",[
 z.object({name,shape:z.literal("circle"),centre:point,radius:z.number().min(.0001).max(2),boundary:name}).strict(),
 z.object({name,shape:z.literal("polygon"),vertices:polygon,boundary:name}).strict(),
]);
export type FlowBody=z.infer<typeof FlowBody>;
export type Point2=[number,number];
export function bodyLoop(b:FlowBody,size:number):Point2[]{return b.shape==="polygon"?b.vertices:Array.from({length:Math.min(256,Math.max(32,Math.ceil(2*Math.PI*b.radius/size)))},(_,i)=>{const angle=2*Math.PI*i/Math.min(256,Math.max(32,Math.ceil(2*Math.PI*b.radius/size)));return[b.centre[0]+b.radius*Math.cos(angle),b.centre[1]+b.radius*Math.sin(angle)];});}
export const signedArea=(p:Point2[])=>p.reduce((s,a,i)=>{const b=p[(i+1)%p.length]!;return s+a[0]*b[1]-a[1]*b[0];},0)/2;
export function inside(p:Point2,loop:Point2[]){let yes=false;for(let i=0,j=loop.length-1;i<loop.length;j=i++){const a=loop[i]!,b=loop[j]!;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
export function segmentDistance(p:Point2,a:Point2,b:Point2){const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);}
const cross=(a:Point2,b:Point2,c:Point2)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function intersects(a:Point2,b:Point2,c:Point2,d:Point2){return cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]));}
const refinementBase={name,size:z.number().finite().min(.00005).max(.2),transition:z.number().finite().positive().max(20)};
export const MeshRefinement=z.discriminatedUnion("kind",[
 z.object({...refinementBase,kind:z.literal("body-distance"),body:name,distance:z.number().finite().min(0).max(20)}).strict(),
 z.object({...refinementBase,kind:z.literal("box"),min:point,max:point}).strict(),
]);
export type MeshRefinement=z.infer<typeof MeshRefinement>;
/** Shared size field; units are metres. Smallest overlapping request wins. */
export function refinementSize(c:{meshSize:number;bodies:FlowBody[];refinements?:MeshRefinement[] | undefined},p:Point2){
 let size=c.meshSize;
 for(const r of c.refinements??[]){
  let distance:number;
  if(r.kind==="box")distance=Math.hypot(Math.max(r.min[0]-p[0],0,p[0]-r.max[0]),Math.max(r.min[1]-p[1],0,p[1]-r.max[1]));
  else{
   const b=c.bodies.find(b=>b.name===r.body);if(!b)continue;
   const d=b.shape==="circle"?Math.max(0,Math.hypot(p[0]-b.centre[0],p[1]-b.centre[1])-b.radius):inside(p,b.vertices)?0:Math.min(...b.vertices.map((v,i)=>segmentDistance(p,v,b.vertices[(i+1)%b.vertices.length]!)));
   distance=Math.max(0,d-r.distance);
  }
  size=Math.min(size,r.size+(c.meshSize-r.size)*Math.min(1,distance/r.transition));
 }
 return size;
}
export function bodyMeshSize(c:{meshSize:number;refinements?:MeshRefinement[] | undefined},b:FlowBody){
 // Conservative surface tessellation also resolves boxes crossing a body.
 return Math.min(c.meshSize,...(c.refinements??[]).filter(r=>r.kind==="box"||r.body===b.name).map(r=>r.size));
}
export const PitchMotion=z.object({kind:z.literal("pitch"),body:name,pivot:point,meanAngleDegrees:z.number().finite().min(-180).max(180),amplitudeDegrees:z.number().finite().positive().max(20),frequencyHz:z.number().finite().positive().max(100)}).strict();
export type PitchMotion=z.infer<typeof PitchMotion>;
export function pitchPoint(p:Point2,m:PitchMotion,time:number):Point2{
 const a=(m.meanAngleDegrees+m.amplitudeDegrees*Math.sin(2*Math.PI*m.frequencyHz*time))*Math.PI/180,x=p[0]-m.pivot[0],y=p[1]-m.pivot[1];
 return[m.pivot[0]+x*Math.cos(a)-y*Math.sin(a),m.pivot[1]+x*Math.sin(a)+y*Math.cos(a)];
}
export function posedBody(b:FlowBody,m:PitchMotion|undefined,time=0):FlowBody{
 if(!m||m.body!==b.name)return b;
 return b.shape==="circle"?{...b,centre:pitchPoint(b.centre,m,time)}:{...b,vertices:b.vertices.map(p=>pitchPoint(p,m,time))};
}
export const PlanarCase=z.object({
 version:z.literal(1),geometry:z.literal("planar"),
 domain:z.object({vertices:polygon,edgeBoundaries:z.array(name).min(3).max(80)}).strict(),
 bodies:z.array(FlowBody).max(24),boundaries:z.array(FlowBoundary).min(2).max(100),
 region:z.object({name,material:z.string().min(1).max(80),density:z.number().min(.1).max(20000),nu:z.number().min(1e-8).max(.01)}).strict(),
 meshSize:z.number().min(.00005).max(.2),
 refinements:z.array(MeshRefinement).max(32).optional(),
 motion:PitchMotion.optional(),
 initialVelocity:point,duration:z.number().min(.001).max(100),frames:z.number().int().min(2).max(100),
}).strict().superRefine((c,ctx)=>{
 const errors=new Set<string>();
 const issue=(message:string)=>{if(!errors.has(message)){errors.add(message);ctx.addIssue({code:"custom",message});}};
 if(c.domain.edgeBoundaries.length!==c.domain.vertices.length)issue("Each domain edge needs one named boundary (edge i joins vertex i to the next)");
 const names=c.boundaries.map(b=>b.name),used=[...c.domain.edgeBoundaries,...c.bodies.map(b=>b.boundary)];
 if(new Set(names).size!==names.length||new Set(c.bodies.map(b=>b.name)).size!==c.bodies.length)issue("Boundary and body names must be unique");
 if(used.some(n=>!names.includes(n))||names.some(n=>!used.includes(n)))issue("Boundary definitions must exactly cover the domain edges and body surfaces");
 if(!c.boundaries.some(b=>b.type==="velocity-inlet")||!c.boundaries.some(b=>b.type==="pressure-outlet"))issue("Define at least one velocity inlet and pressure outlet");
 if(c.bodies.some(b=>c.boundaries.find(p=>p.name===b.boundary)?.type!=="wall"))issue("Excluded bodies need no-slip wall boundaries");
 const refinements=c.refinements??[];
 if(new Set(refinements.map(r=>r.name)).size!==refinements.length)issue("Refinement names must be unique");
 for(const r of refinements){
  if(r.size>c.meshSize)issue("Refinement size must not exceed background meshSize");
  if(r.transition<2*(c.meshSize-r.size))issue("Refinement transition must be at least twice the difference between background and target size");
  if(r.kind==="body-distance"&&!c.bodies.some(b=>b.name===r.body))issue("Refinement refers to an unknown body");
  if(r.kind==="box"&&(r.min[0]>=r.max[0]||r.min[1]>=r.max[1]))issue("Refinement box min must be smaller than max on both axes");
  if(r.kind==="box"&&(r.max[0]<Math.min(...c.domain.vertices.map(p=>p[0]))||r.min[0]>Math.max(...c.domain.vertices.map(p=>p[0]))||r.max[1]<Math.min(...c.domain.vertices.map(p=>p[1]))||r.min[1]>Math.max(...c.domain.vertices.map(p=>p[1]))))issue("Refinement box must intersect the domain bounds");
 }
 if(c.motion){
  const m=c.motion,b=c.bodies.find(b=>b.name===m.body);
  if(!b)issue("Pitch motion refers to an unknown body");
  if(c.frames<c.duration*m.frequencyHz*16)issue("Pitch playback needs at least 16 saved frames per cycle; increase frames or reduce frequency/duration");
  if(b){
   if(c.bodies.filter(other=>other.boundary===b.boundary).length!==1||c.domain.edgeBoundaries.includes(b.boundary))issue("Moving body needs its own wall boundary");
   const radius=b.shape==="circle"?Math.hypot(b.centre[0]-m.pivot[0],b.centre[1]-m.pivot[1])+b.radius:Math.max(...b.vertices.map(p=>Math.hypot(p[0]-m.pivot[0],p[1]-m.pivot[1])));
   if(!inside(m.pivot,c.domain.vertices)||c.domain.vertices.some((p,i)=>segmentDistance(m.pivot,p,c.domain.vertices[(i+1)%c.domain.vertices.length]!)<radius+c.meshSize))issue("Pitching body needs a clear rotation envelope inside the domain, with at least one background cell of clearance");
   for(const other of c.bodies.filter(other=>other!==b)){const loop=bodyLoop(other,bodyMeshSize(c,other));if(inside(m.pivot,loop)||loop.some((p,i)=>segmentDistance(m.pivot,p,loop[(i+1)%loop.length]!)<radius+c.meshSize))issue("Pitch rotation envelope is too close to another body");}
  }
 }
 const loops=[c.domain.vertices,...c.bodies.map(b=>bodyLoop(posedBody(b,c.motion),bodyMeshSize(c,b)))];
 for(const p of loops){
  if(Math.abs(signedArea(p))<1e-10)issue("Geometry has zero area");
  for(let i=0;i<p.length;i++){if(Math.hypot(p[i]![0]-p[(i+1)%p.length]![0],p[i]![1]-p[(i+1)%p.length]![1])<1e-8)issue("Geometry has duplicate vertices");for(let j=i+2;j<p.length;j++){if(i===0&&j===p.length-1)continue;if(intersects(p[i]!,p[(i+1)%p.length]!,p[j]!,p[(j+1)%p.length]!))issue("Polygon edges must not cross or touch");}}
 }
 for(let i=1;i<loops.length;i++){
  const a=loops[i]!;if(a.some(p=>!inside(p,loops[0]!)))issue("Every body must lie strictly inside the fluid domain");
  for(let j=0;j<i;j++){const b=loops[j]!;if(j>0&&(inside(a[0]!,b)||inside(b[0]!,a)))issue("Bodies must not overlap or contain each other");
   for(let k=0;k<a.length;k++)for(let l=0;l<b.length;l++)if(intersects(a[k]!,a[(k+1)%a.length]!,b[l]!,b[(l+1)%b.length]!)||Math.min(segmentDistance(a[k]!,b[l]!,b[(l+1)%b.length]!),segmentDistance(b[l]!,a[k]!,a[(k+1)%a.length]!))<c.meshSize*.25)issue("Bodies intersect or have a gap too small for meshSize");
  }
 }
 const p=c.domain.vertices,w=Math.max(...p.map(p=>p[0]))-Math.min(...p.map(p=>p[0])),h=Math.max(...p.map(p=>p[1]))-Math.min(...p.map(p=>p[1]));
 if(w*h/(c.meshSize*c.meshSize)>5000)issue("Requested resolution exceeds the local mesh budget; increase meshSize");
 if(Math.min(w,h)<2*c.meshSize)issue("meshSize must resolve the fluid domain");
});
export type PlanarCase=z.infer<typeof PlanarCase>;
export const defaultPlanar:PlanarCase={version:1,geometry:"planar",domain:{vertices:[[-.05,-.04],[.15,-.04],[.15,.04],[-.05,.04]],edgeBoundaries:["sides","outlet","sides","inlet"]},bodies:[{name:"frontCylinder",shape:"circle",centre:[0,0],radius:.005,boundary:"frontWall"},{name:"upperCylinder",shape:"circle",centre:[Math.sqrt(3)*.025/2,.0125],radius:.005,boundary:"upperWall"},{name:"lowerCylinder",shape:"circle",centre:[Math.sqrt(3)*.025/2,-.0125],radius:.005,boundary:"lowerWall"}],boundaries:[{name:"inlet",type:"velocity-inlet",velocity:[.1,0]},{name:"outlet",type:"pressure-outlet",pressure:0},{name:"sides",type:"symmetry"},{name:"frontWall",type:"wall"},{name:"upperWall",type:"wall"},{name:"lowerWall",type:"wall"}],region:{name:"fluid",material:"Constant-property fluid",density:1000,nu:.00001},meshSize:.0025,initialVelocity:[.1,.001],duration:10,frames:100};
