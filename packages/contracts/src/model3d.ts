import { z } from "zod";
/**
 * Imported 3-D models: STL (binary or ASCII) and OBJ surfaces, welded into one closed, outward-facing
 * triangulation. The normalized surface travels as a binary STL compute asset; a study keeps only its
 * reference and measurements, in the model's own units, so it stays small enough for a job spec.
 */
export const MODEL_MAX_TRIANGLES=200_000;
/** Raw files read before normalizing; ASCII STL is about five times larger than binary. */
export const MODEL_MAX_FILE_BYTES=100*1024*1024;
export const MODEL_EXTENSIONS=[".stl",".obj"] as const;
type Point3=[number,number,number];
// Homogeneous arrays keep agent tool schemas transport-compatible; TS retains the tuple.
const nativeVec=z.array(z.number().finite().min(-1e6).max(1e6)).length(3).transform(p=>p as Point3);
/** Reference to a normalized model and its measurements in native units (before scale and rotation). */
export const Model3D=z.object({
 assetId:z.string().min(1).max(64),file:z.string().min(1).max(120),sha256:z.string().min(8).max(128),
 triangles:z.number().int().min(4).max(MODEL_MAX_TRIANGLES),
 min:nativeVec,max:nativeVec,
 area:z.number().finite().positive(),volume:z.number().finite().positive(),
 // Silhouette area seen along native x, y and z.
 projectedArea:z.array(z.number().finite().nonnegative()).length(3).transform(p=>p as Point3),
 // What import fixed: triangle edges split at T-junctions, and small gaps closed with the widest gap's hydraulic diameter.
 repairs:z.object({tJunctions:z.number().int().nonnegative(),gaps:z.number().int().nonnegative(),widestGap:z.number().finite().nonnegative()}).strict().optional(),
}).strict();
export type Model3D=z.infer<typeof Model3D>;
/** Quarter turns only, so the rotated bounding box, and so every validation check, stays exact. */
export const QuarterTurns=z.array(z.number().int().min(0).max(270).multipleOf(90)).length(3).transform(p=>p as Point3);
export type Surface={points:Float64Array;triangles:Uint32Array};
export type ModelMeasures=Omit<Model3D,"assetId"|"file"|"sha256">&{shells:number};
/** Gaps up to this fraction of the model's largest dimension (as a hydraulic diameter) are closed on import. */
export const MODEL_GAP_LIMIT=.01;

function extension(file:string){return file.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]??"";}
/** Binary STL when the size matches its triangle count; ASCII STL otherwise. */
function isBinaryStl(bytes:Uint8Array){
 if(bytes.byteLength<84)return false;
 const n=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(80,true);
 return bytes.byteLength===84+50*n;
}
function tooMany(n:number){if(n>MODEL_MAX_TRIANGLES)throw new Error(`The model has ${n.toLocaleString("en-US")} triangles; the limit is ${MODEL_MAX_TRIANGLES.toLocaleString("en-US")}. Decimate it and export again`);}
function readStl(bytes:Uint8Array):Surface{
 if(isBinaryStl(bytes)){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=view.getUint32(80,true);tooMany(n);
  const points=new Float64Array(n*9);
  for(let t=0;t<n;t++)for(let k=0;k<9;k++)points[9*t+k]=view.getFloat32(84+50*t+12+4*k,true);
  return{points,triangles:Uint32Array.from({length:n*3},(_,i)=>i)};
 }
 const text=new TextDecoder().decode(bytes);
 if(!/^\s*solid/.test(text))throw new Error("Not an STL file: neither binary nor ASCII");
 const values:number[]=[],number="([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)";
 for(const m of text.matchAll(new RegExp(`vertex\\s+${number}\\s+${number}\\s+${number}`,"g")))values.push(Number(m[1]),Number(m[2]),Number(m[3]));
 if(values.length%9)throw new Error("ASCII STL has an incomplete facet");
 tooMany(values.length/9);
 return{points:Float64Array.from(values),triangles:Uint32Array.from({length:values.length/3},(_,i)=>i)};
}
/** Vertices and faces; polygons are fanned, texture and normal indices ignored, negative indices resolved. */
function readObj(bytes:Uint8Array):Surface{
 const points:number[]=[],triangles:number[]=[];
 for(const raw of new TextDecoder().decode(bytes).split("\n")){
  const line=raw.trim();
  if(/^v\s/.test(line)){const p=line.slice(2).trim().split(/\s+/).slice(0,3).map(Number);if(p.length<3)throw new Error("OBJ vertex needs x, y and z");points.push(...p);}
  else if(/^f\s/.test(line)){
   const count=points.length/3,ids=line.slice(2).trim().split(/\s+/).map(token=>{const i=parseInt(token.split("/")[0]!,10);return i<0?count+i:i-1;});
   if(ids.length<3||ids.some(i=>!Number.isInteger(i)||i<0||i>=count))throw new Error("OBJ face refers to a missing vertex");
   for(let k=1;k+1<ids.length;k++)triangles.push(ids[0]!,ids[k]!,ids[k+1]!);
   tooMany(triangles.length/3);
  }
 }
 return{points:Float64Array.from(points),triangles:Uint32Array.from(triangles)};
}
/** Parse an STL or OBJ file into an indexed triangle surface, unwelded. */
export function readModel(bytes:Uint8Array,file:string):Surface{
 if(bytes.byteLength>MODEL_MAX_FILE_BYTES)throw new Error("Model files must be 100 MB or smaller");
 const ext=extension(file);
 const s=ext===".obj"?readObj(bytes):ext===".stl"?readStl(bytes):(()=>{throw new Error(`Import STL or OBJ; ${ext||"this file type"} is not supported. Export STEP or other CAD formats as STL first`);})();
 if(!s.triangles.length)throw new Error("The model has no triangles");
 if(!s.points.every(Number.isFinite))throw new Error("The model has non-finite coordinates");
 return s;
}
function boundsOf(points:Float64Array){
 const min:Point3=[Infinity,Infinity,Infinity],max:Point3=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<points.length;i+=3)for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,points[i+k]!);max[k]=Math.max(max[k]!,points[i+k]!);}
 return{min,max};
}
/**
 * Merge vertices within 1e-7 of the model's diagonal (float32 exports round the same corner differently)
 * and drop triangles that collapse to an edge or point. Neighbouring grid cells are searched, so two
 * nearby vertices merge even when they straddle a cell boundary.
 */
export function weld(s:Surface):Surface{
 const {min,max}=boundsOf(s.points),diagonal=Math.hypot(max[0]-min[0],max[1]-min[1],max[2]-min[2]);
 if(!(diagonal>0))throw new Error("The model has no extent");
 const q=diagonal*1e-7,grid=new Map<number,number[]>(),remap=new Uint32Array(s.points.length/3),points:number[]=[];
 const hash=(x:number,y:number,z:number)=>(Math.imul(x,73856093)^Math.imul(y,19349663)^Math.imul(z,83492791))>>>0;
 for(let i=0;i<remap.length;i++){
  const x=s.points[3*i]!,y=s.points[3*i+1]!,z=s.points[3*i+2]!,cx=Math.floor((x-min[0])/q),cy=Math.floor((y-min[1])/q),cz=Math.floor((z-min[2])/q);
  let id=-1;
  for(let dx=-1;dx<=1&&id<0;dx++)for(let dy=-1;dy<=1&&id<0;dy++)for(let dz=-1;dz<=1&&id<0;dz++)
   for(const j of grid.get(hash(cx+dx,cy+dy,cz+dz))??[])if(Math.abs(points[3*j]!-x)<=q&&Math.abs(points[3*j+1]!-y)<=q&&Math.abs(points[3*j+2]!-z)<=q){id=j;break;}
  if(id<0){id=points.length/3;points.push(x,y,z);const key=hash(cx,cy,cz),cell=grid.get(key);if(cell)cell.push(id);else grid.set(key,[id]);}
  remap[i]=id;
 }
 const triangles:number[]=[];
 for(let t=0;t<s.triangles.length;t+=3){const a=remap[s.triangles[t]!]!,b=remap[s.triangles[t+1]!]!,c=remap[s.triangles[t+2]!]!;if(a!==b&&b!==c&&a!==c)triangles.push(a,b,c);}
 return{points:Float64Array.from(points),triangles:Uint32Array.from(triangles)};
}
/** Edges used by an odd number of triangles, each with the triangle and direction that owns it. */
function openEdges(s:{points:ArrayLike<number>;triangles:ArrayLike<number>}){
 const n=s.points.length/3,t=s.triangles,uses=new Map<number,number[]>();
 for(let k=0;k<t.length/3;k++)for(let j=0;j<3;j++){const a=t[3*k+j]!,b=t[3*k+(j+1)%3]!,key=Math.min(a,b)*n+Math.max(a,b);let u=uses.get(key);if(!u){u=[];uses.set(key,u);}u.push(k,a,b);}
 const open:{tri:number;a:number;b:number}[]=[];
 for(const u of uses.values())if((u.length/3)%2)open.push({tri:u[0]!,a:u[1]!,b:u[2]!});
 return open;
}
/**
 * Split triangles where another triangle's corner lies on their open edge (a T-junction), so both sides
 * share the vertex. CAD tessellations of neighbouring faces commonly leave these.
 */
export function repairTJunctions(s:Surface){
 const {min,max}=boundsOf(s.points),tol=Math.hypot(max[0]-min[0],max[1]-min[1],max[2]-min[2])*1e-6,p=s.points;
 let tri=Array.from(s.triangles),count=0;
 for(let pass=0;pass<64;pass++){
  const open=openEdges({points:p,triangles:tri}),corners=[...new Set(open.flatMap(e=>[e.a,e.b]))],splits=new Map<number,{v:number;at:number;a:number;b:number}>();
  for(const e of open){
   const ax=p[3*e.a]!,ay=p[3*e.a+1]!,az=p[3*e.a+2]!,dx=p[3*e.b]!-ax,dy=p[3*e.b+1]!-ay,dz=p[3*e.b+2]!-az,l2=dx*dx+dy*dy+dz*dz;
   for(const v of corners){
    if(v===e.a||v===e.b)continue;
    const at=((p[3*v]!-ax)*dx+(p[3*v+1]!-ay)*dy+(p[3*v+2]!-az)*dz)/l2;
    if(at<=1e-9||at>=1-1e-9)continue;
    if(Math.hypot(ax+at*dx-p[3*v]!,ay+at*dy-p[3*v+1]!,az+at*dz-p[3*v+2]!)>tol)continue;
    // One split per triangle per pass: the nearest to the edge's start, so the pieces stay ordered.
    const prior=splits.get(e.tri);if(!prior||at<prior.at)splits.set(e.tri,{v,at,a:e.a,b:e.b});
   }
  }
  if(!splits.size)break;
  // Triangle (a, b, c) becomes (a, v, c) and (v, b, c), keeping its winding.
  for(const [k,{v,a,b}] of splits){const c=[tri[3*k]!,tri[3*k+1]!,tri[3*k+2]!].find(x=>x!==a&&x!==b)!;tri.splice(3*k,3,a,v,c);tri.push(v,b,c);count++;}
 }
 return{surface:{points:s.points,triangles:Uint32Array.from(tri)},count};
}
/**
 * Close the remaining small gaps with a fan from each gap's centre. A gap is sized by its hydraulic
 * diameter, 4 × area / perimeter: its diameter when round and twice its width when a slit, with the
 * area projected (a vector sum), so a hole in a curved surface counts no larger than its opening. Larger
 * gaps, or boundaries that branch, mean the model is genuinely open and are refused.
 */
export function fillGaps(s:Surface,limit=MODEL_GAP_LIMIT){
 const open=openEdges(s),next=new Map<number,number>(),{min,max}=boundsOf(s.points),size=Math.max(max[0]-min[0],max[1]-min[1],max[2]-min[2]);
 const refuse=(detail:string)=>new Error(`The surface is not closed: ${open.length.toLocaleString("en-US")} edge${open.length===1?" belongs":"s belong"} to a single triangle${detail}. snappyHexMesh needs a watertight surface; close the holes (for example with Blender's 3D-Print Toolbox or MeshLab) and export again`);
 // A gap's boundary runs against its neighbours' edges, so the filling triangles face the same way.
 for(const e of open){if(next.has(e.b))throw refuse(", and its gaps branch");next.set(e.b,e.a);}
 const points=Array.from(s.points),triangles=Array.from(s.triangles);let gaps=0,widest=0;
 while(next.size){
  const [start]=next.keys(),loop:number[]=[];let v:number|undefined=start!;
  while(v!==undefined&&next.has(v)){loop.push(v);const w:number=next.get(v)!;next.delete(v);v=w;}
  if(v!==start||loop.length<3)throw refuse(", and a gap does not close on itself");
  const c=[0,1,2].map(i=>loop.reduce((sum,q)=>sum+s.points[3*q+i]!,0)/loop.length),centre=points.length/3;
  // Vector area: a sliver that folds back on itself spans almost none, however long its sides.
  const vector:Point3=[0,0,0];let perimeter=0;
  for(let i=0;i<loop.length;i++){
   const a=loop[i]!,b=loop[(i+1)%loop.length]!,u=[0,1,2].map(k=>s.points[3*a+k]!-c[k]!),w=[0,1,2].map(k=>s.points[3*b+k]!-c[k]!);
   vector[0]+=u[1]!*w[2]!-u[2]!*w[1]!;vector[1]+=u[2]!*w[0]!-u[0]!*w[2]!;vector[2]+=u[0]!*w[1]!-u[1]!*w[0]!;
   perimeter+=Math.hypot(...[0,1,2].map(k=>s.points[3*b+k]!-s.points[3*a+k]!));
   triangles.push(a,b,centre);
  }
  const width=4*(Math.hypot(...vector)/2)/perimeter;
  if(width>limit*size)throw refuse(`; the widest gap is about ${Number(width.toPrecision(2))} units across (${Number((width/size*100).toPrecision(2))}% of the model, over the ${limit*100}% Beam closes)`);
  points.push(...c);gaps++;widest=Math.max(widest,width);
 }
 return{surface:{points:Float64Array.from(points),triangles:Uint32Array.from(triangles)},gaps,widest};
}
function signedVolume(s:Surface,tris:Iterable<number>){
 let v=0;const p=s.points,t=s.triangles;
 for(const k of tris){const a=3*t[3*k]!,b=3*t[3*k+1]!,c=3*t[3*k+2]!;v+=(p[a]!*(p[b+1]!*p[c+2]!-p[b+2]!*p[c+1]!)-p[a+1]!*(p[b]!*p[c+2]!-p[b+2]!*p[c]!)+p[a+2]!*(p[b]!*p[c+1]!-p[b+1]!*p[c]!))/6;}
 return v;
}
/**
 * Require a closed surface and orient it outward. Every edge must be shared by an even number of
 * triangles; neighbours across two-sided edges are made consistent, then each shell faces outward.
 */
export function closeAndOrient(s:Surface):{surface:Surface;shells:number}{
 const n=s.points.length/3,tri=s.triangles,count=tri.length/3,edges=new Map<number,number[]>();
 for(let t=0;t<count;t++)for(let k=0;k<3;k++){
  const a=tri[3*t+k]!,b=tri[3*t+(k+1)%3]!,key=Math.min(a,b)*n+Math.max(a,b);
  let list=edges.get(key);if(!list){list=[];edges.set(key,list);}list.push(t,a<b?1:-1);
 }
 let open=0;for(const list of edges.values())if((list.length/2)%2)open++;
 if(open)throw new Error(`The surface is not closed: ${open.toLocaleString("en-US")} edge${open===1?" belongs":"s belong"} to a single triangle. snappyHexMesh needs a watertight surface; close the holes (for example with Blender's 3D-Print Toolbox or MeshLab) and export again`);
 const flip=new Int8Array(count),seen=new Uint8Array(count),out=Uint32Array.from(tri);let shells=0;
 for(let start=0;start<count;start++){
  if(seen[start])continue;
  shells++;const members:number[]=[start],queue=[start];seen[start]=1;
  while(queue.length){
   const t=queue.pop()!;
   for(let k=0;k<3;k++){
    const a=tri[3*t+k]!,b=tri[3*t+(k+1)%3]!,list=edges.get(Math.min(a,b)*n+Math.max(a,b))!;
    if(list.length!==4)continue;
    const mine=list[0]===t?1:3,other=list[mine===1?2:0]!,same=list[1]===list[3];
    if(other===t||seen[other])continue;
    // A consistent neighbour walks the shared edge the other way.
    flip[other]=(same?1-flip[t]!:flip[t]!) as 0|1;seen[other]=1;members.push(other);queue.push(other);
   }
  }
  for(const t of members)if(flip[t]){out[3*t+1]=tri[3*t+2]!;out[3*t+2]=tri[3*t+1]!;}
  const oriented={points:s.points,triangles:out};
  if(signedVolume(oriented,members)<0)for(const t of members){const b=out[3*t+1]!;out[3*t+1]=out[3*t+2]!;out[3*t+2]=b;}
 }
 return{surface:{points:s.points,triangles:out},shells};
}
/** Silhouette area along one axis, rasterized on a grid over the projected bounding box. */
function projectedArea(s:Surface,axis:0|1|2,{min,max}:{min:Point3;max:Point3},grid=400){
 const u=(axis+1)%3,v=(axis+2)%3,du=(max[u]!-min[u]!)/grid,dv=(max[v]!-min[v]!)/grid;
 if(!(du>0&&dv>0))return 0;
 const cells=new Uint8Array(grid*grid),p=s.points,t=s.triangles;
 for(let k=0;k<t.length;k+=3){
  const x=[p[3*t[k]!+u]!,p[3*t[k+1]!+u]!,p[3*t[k+2]!+u]!].map(x=>(x-min[u]!)/du),y=[p[3*t[k]!+v]!,p[3*t[k+1]!+v]!,p[3*t[k+2]!+v]!].map(y=>(y-min[v]!)/dv);
  const area=(x[1]!-x[0]!)*(y[2]!-y[0]!)-(x[2]!-x[0]!)*(y[1]!-y[0]!);if(!area)continue;
  const i0=Math.max(0,Math.ceil(Math.min(...x)-.5)),i1=Math.min(grid-1,Math.floor(Math.max(...x)-.5)),j0=Math.max(0,Math.ceil(Math.min(...y)-.5)),j1=Math.min(grid-1,Math.floor(Math.max(...y)-.5));
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
   if(cells[j*grid+i])continue;
   const cx=i+.5,cy=j+.5,e=(a:number,b:number)=>((x[b]!-x[a]!)*(cy-y[a]!)-(y[b]!-y[a]!)*(cx-x[a]!))*Math.sign(area);
   if(e(0,1)>=0&&e(1,2)>=0&&e(2,0)>=0)cells[j*grid+i]=1;
  }
 }
 let filled=0;for(const c of cells)filled+=c;
 return filled*du*dv;
}
export function measureModel(s:Surface,shells=1):ModelMeasures{
 const b=boundsOf(s.points),p=s.points,t=s.triangles;let area=0;
 for(let k=0;k<t.length;k+=3){
  const a=3*t[k]!,c=3*t[k+1]!,d=3*t[k+2]!,u=[p[c]!-p[a]!,p[c+1]!-p[a+1]!,p[c+2]!-p[a+2]!],w=[p[d]!-p[a]!,p[d+1]!-p[a+1]!,p[d+2]!-p[a+2]!];
  area+=Math.hypot(u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!)/2;
 }
 const volume=signedVolume(s,Array.from({length:t.length/3},(_,i)=>i));
 if(!(volume>0))throw new Error("The model encloses no volume");
 return{triangles:t.length/3,min:b.min,max:b.max,area,volume,projectedArea:[0,1,2].map(i=>projectedArea(s,i as 0|1|2,b)) as Point3,shells};
}
/** Read, weld, check and orient a model file; the result is ready to store as a binary STL. */
export function normalizeModel(bytes:Uint8Array,file:string){
 const joined=repairTJunctions(weld(readModel(bytes,file))),filled=fillGaps(joined.surface);
 if(filled.surface.triangles.length/3>MODEL_MAX_TRIANGLES)tooMany(filled.surface.triangles.length/3);
 const {surface,shells}=closeAndOrient(filled.surface),measures:ModelMeasures=measureModel(surface,shells);
 if(joined.count||filled.gaps)measures.repairs={tJunctions:joined.count,gaps:filled.gaps,widestGap:filled.widest};
 return{surface,measures,stl:encodeStl(surface)};
}
export function encodeStl(s:{points:ArrayLike<number>;triangles:ArrayLike<number>},header="Beam normalized surface"):Uint8Array{
 const n=s.triangles.length/3,bytes=new Uint8Array(84+50*n),view=new DataView(bytes.buffer);
 bytes.set(new TextEncoder().encode(header.slice(0,79)));view.setUint32(80,n,true);
 const p=s.points,t=s.triangles;
 for(let k=0;k<n;k++){
  const a=3*t[3*k]!,b=3*t[3*k+1]!,c=3*t[3*k+2]!,u=[p[b]!-p[a]!,p[b+1]!-p[a+1]!,p[b+2]!-p[a+2]!],w=[p[c]!-p[a]!,p[c+1]!-p[a+1]!,p[c+2]!-p[a+2]!];
  const normal=[u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!],m=Math.hypot(...normal)||1,at=84+50*k;
  normal.forEach((x,i)=>view.setFloat32(at+4*i,x/m,true));
  [a,b,c].forEach((q,j)=>{for(let i=0;i<3;i++)view.setFloat32(at+12+12*j+4*i,p[q+i]!,true);});
 }
 return bytes;
}
/** A stored model, welded again so it can be checked against the study's measurements. */
export function decodeModel(bytes:Uint8Array){
 if(!isBinaryStl(bytes))throw new Error("Stored model is not a binary STL");
 return weld(readStl(bytes));
}
/** Stored geometry must be the surface the study was set up with, to float32 precision. */
export function modelMatches(m:ModelMeasures,model:Model3D){
 const size=Math.max(...[0,1,2].map(i=>model.max[i]!-model.min[i]!)),tol=size*1e-5;
 return m.triangles===model.triangles&&[0,1,2].every(i=>Math.abs(m.min[i]!-model.min[i]!)<=tol&&Math.abs(m.max[i]!-model.max[i]!)<=tol)&&Math.abs(m.volume-model.volume)<=model.volume*1e-3;
}
export const MODEL_UNITS={m:1,cm:.01,mm:.001,in:.0254,ft:.3048} as const;
export type ModelUnit=keyof typeof MODEL_UNITS;
/** Guess the file's length unit from its size: CAD exports of objects this tool can mesh are usually metres or millimetres. */
export function guessUnits(m:Pick<Model3D,"min"|"max">):ModelUnit{
 return Math.max(...[0,1,2].map(i=>m.max[i]!-m.min[i]!))>20?"mm":"m";
}
type Matrix=[Point3,Point3,Point3];
function multiply(a:Matrix,b:Matrix):Matrix{return a.map(r=>[0,1,2].map(j=>r[0]*b[0][j]!+r[1]*b[1][j]!+r[2]*b[2][j]!)) as Matrix;}
/** Rotation about x, then y, then z (fixed axes), as a signed permutation matrix. */
export function turnMatrix([x,y,z]:readonly number[]):Matrix{
 const c=(d:number)=>Math.round(Math.cos(d*Math.PI/180)),s=(d:number)=>Math.round(Math.sin(d*Math.PI/180));
 const rx:Matrix=[[1,0,0],[0,c(x!),-s(x!)],[0,s(x!),c(x!)]],ry:Matrix=[[c(y!),0,s(y!)],[0,1,0],[-s(y!),0,c(y!)]],rz:Matrix=[[c(z!),-s(z!),0],[s(z!),c(z!),0],[0,0,1]];
 return multiply(rz,multiply(ry,rx));
}
export type ModelPlacement={model:Model3D;scale:number;rotation:readonly number[];position:readonly number[]};
/**
 * World placement: scale, rotate, then translate so the front-bottom-centre of the rotated bounding
 * box (min x, mid y, min z) lands on position, as the Ahmed body's nose does.
 */
export function placement(b:ModelPlacement){
 const r=turnMatrix(b.rotation),turn=(p:readonly number[])=>r.map(row=>b.scale*(row[0]*p[0]!+row[1]*p[1]!+row[2]*p[2]!)) as Point3;
 const corners=[0,1,2,3,4,5,6,7].map(k=>turn([k&1?b.model.max[0]:b.model.min[0],k&2?b.model.max[1]:b.model.min[1],k&4?b.model.max[2]:b.model.min[2]]));
 const lo=[0,1,2].map(i=>Math.min(...corners.map(c=>c[i]!))),hi=[0,1,2].map(i=>Math.max(...corners.map(c=>c[i]!)));
 const shift=[b.position[0]!-lo[0]!,b.position[1]!-(lo[1]!+hi[1]!)/2,b.position[2]!-lo[2]!];
 return{
  point:(p:readonly number[])=>{const q=turn(p);return[q[0]+shift[0]!,q[1]+shift[1]!,q[2]+shift[2]!] as Point3;},
  min:lo.map((v,i)=>v+shift[i]!) as Point3,max:hi.map((v,i)=>v+shift[i]!) as Point3,
  // The native axis that ends up along world x, whose silhouette faces the flow.
  streamwiseAxis:[0,1,2].find(i=>r[0][i]!==0)!,
 };
}
/** The model surface in world coordinates. Quarter turns that mirror nothing keep it outward-facing. */
export function placeSurface(b:ModelPlacement,s:Surface):Surface{
 const place=placement(b),points=new Float64Array(s.points.length);
 for(let i=0;i<points.length;i+=3)points.set(place.point([s.points[i]!,s.points[i+1]!,s.points[i+2]!]),i);
 return{points,triangles:s.triangles};
}
