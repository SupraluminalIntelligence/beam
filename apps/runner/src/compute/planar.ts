import triangulate from "cdt2d";
import { PlanarCase, posedBody, pitchPoint, bodyLoop, bodyMeshSize, refinementSize, inside, segmentDistance, signedArea, type Point2 } from "@beam/contracts";
const header=(object:string,klass="dictionary")=>`FoamFile { version 2.0; format ascii; class ${klass}; object ${object}; }\n`;
const key=(a:number,b:number)=>a<b?`${a},${b}`:`${b},${a}`;
/** Constrained Delaunay triangles extruded one cell deep. All surfaces have explicit patches. */
export function planarMesh(raw:PlanarCase){
 const parsed=PlanarCase.parse(raw),c={...parsed,bodies:parsed.bodies.map(b=>posedBody(b,parsed.motion))},h=c.meshSize,points:Point2[]=[],edges:number[][]=[],patches=new Map<string,string>();
 const refined=!!c.refinements?.length;
 const loops=[c.domain.vertices,...parsed.bodies.map(b=>bodyLoop(b,bodyMeshSize(c,b)).map(p=>c.motion?.body===b.name?pitchPoint(p,c.motion,0):p))];
 loops.forEach((loop,l)=>{
  const start=points.length;
  loop.forEach((a,i)=>{const b=loop[(i+1)%loop.length]!;
   const add=(p:Point2)=>{const at=points.length;points.push(p);if(points.length>6500)throw new Error("Refinement exceeds mesh point budget; increase target sizes or reduce refinement extents");edges.push([at,at+1]);patches.set(key(at,at+1),l===0?c.domain.edgeBoundaries[i]!:c.bodies[l-1]!.boundary);};
   if(!refined){const n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/h));for(let k=0;k<n;k++)add([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);}
   else{
    const split=(p:Point2,q:Point2,depth:number)=>{const mid:Point2=[(p[0]+q[0])/2,(p[1]+q[1])/2];
     if(Math.hypot(q[0]-p[0],q[1]-p[1])>Math.min(refinementSize(c,p),refinementSize(c,q),refinementSize(c,mid))*1.25){if(depth>20)throw new Error("Refinement depth budget exceeded");split(p,mid,depth+1);split(mid,q,depth+1);}else add(p);
    };split(a,b,0);
   }
  });
  const last=points.length-1,boundary=patches.get(key(last,last+1))!;patches.delete(key(last,last+1));edges[edges.length-1]=[last,start];patches.set(key(last,start),boundary);
 });
 const xs=c.domain.vertices.map(p=>p[0]),ys=c.domain.vertices.map(p=>p[1]);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 if(!refined){
 for(let row=0,y=minY+h*.7;y<maxY;y+=h*Math.sqrt(3)/2,row++)for(let x=minX+h*(row%2?.5:1);x<maxX;x+=h){const p:Point2=[x,y];if(!inside(p,loops[0]!)||loops.slice(1).some(l=>inside(p,l)))continue;if(edges.some(([a,b])=>segmentDistance(p,points[a!]!,points[b!]!)<h*.4))continue;points.push(p);}
 }else{
  let visited=0;
  const sample=(x:number,y:number,size:number)=>{
   if(++visited>100000)throw new Error("Refinement sampling budget exceeded; reduce extent or increase target size");
   if(x>=maxX||y>=maxY)return;
   const p:Point2=[x+size/2,y+size/2];
   // Distance-based sizes vary continuously; sample corners as well so small
   // requested regions cannot disappear between coarse candidate centres.
   const target=Math.min(...([p,[x,y],[x+size,y],[x,y+size],[x+size,y+size]] as Point2[]).map(p=>refinementSize(c,p)));
   if(size>target*1.25){for(const dx of [0,size/2])for(const dy of [0,size/2])sample(x+dx,y+dy,size/2);return;}
   if(!inside(p,loops[0]!)||loops.slice(1).some(l=>inside(p,l)))return;
   if(edges.some(([a,b])=>segmentDistance(p,points[a!]!,points[b!]!)<target*.35))return;
   points.push(p);if(points.length>6500)throw new Error("Refinement exceeds mesh point budget; increase target sizes or reduce refinement extents");
  };
  for(let y=minY;y<maxY;y+=h)for(let x=minX;x<maxX;x+=h)sample(x,y,h);
 }
 if(points.length>6500)throw new Error("Geometry exceeds mesh point budget; increase meshSize");
 const triangles=triangulate(points,edges,{exterior:false}).map(t=>signedArea(t.map(i=>points[i]!))<0?[t[0]!,t[2]!,t[1]!]:t);
 if(!triangles.length||triangles.length>12000)throw new Error("Mesh must contain 1–12,000 cells; adjust meshSize");
 const sides=new Map<string,{face:number[];owner:number;neighbour?:number;patch?:string}>(),front:{face:number[];owner:number;patch:string}[]=[];
 const n=points.length;
 triangles.forEach((t,cell)=>{front.push({face:t.slice().reverse(),owner:cell,patch:"frontAndBack"},{face:t.map(i=>i+n),owner:cell,patch:"frontAndBack"});
  t.forEach((a,j)=>{const b=t[(j+1)%3]!,k=key(a,b),old=sides.get(k);if(old){if(old.neighbour!==undefined)throw new Error("Non-manifold mesh edge");old.neighbour=cell;}else sides.set(k,{face:[a,b,b+n,a+n],owner:cell,...(patches.has(k)?{patch:patches.get(k)!}:{})});});
 });
 const internal=[...sides.values()].filter(f=>f.neighbour!==undefined).sort((a,b)=>a.owner-b.owner||a.neighbour!-b.neighbour!);
 const boundary=[...sides.values()].filter(f=>f.neighbour===undefined);
 if(boundary.some(f=>!f.patch)||internal.some(f=>f.patch))throw new Error("Incomplete boundary coverage");
 const faces=[...internal];const patchRows:string[]=[];
 for(const p of [...c.boundaries.map(b=>({name:b.name,type:b.type==="wall"?"wall":b.type==="symmetry"?"symmetry":"patch"})),{name:"frontAndBack",type:"empty"}]){
  const rows=p.name==="frontAndBack"?front:boundary.filter(f=>f.patch===p.name);if(!rows.length)throw new Error(`Boundary ${p.name} has no mesh faces`);
  patchRows.push(`${p.name} { type ${p.type}; nFaces ${rows.length}; startFace ${faces.length}; }`);faces.push(...rows);
 }
 const list=(name:string,klass:string,values:string[])=>header(name,klass)+`${values.length}\n(\n${values.join("\n")}\n)\n`;
 return {cells:triangles.length,polygons:triangles.map(t=>t.map(i=>points[i]!)),files:{
  "constant/polyMesh/points":list("points","vectorField",[0,h].flatMap(z=>points.map(p=>`(${p[0]} ${p[1]} ${z})`))),
  "constant/polyMesh/faces":list("faces","faceList",faces.map(f=>`${f.face.length}(${f.face.join(" ")})`)),
  "constant/polyMesh/owner":list("owner","labelList",faces.map(f=>String(f.owner))),
  "constant/polyMesh/neighbour":list("neighbour","labelList",internal.map(f=>String(f.neighbour))),
  "constant/polyMesh/boundary":list("boundary","polyBoundaryMesh",patchRows),
 }};
}
// Keep transport gradients limited, but reconstruct diagnostic curl independently.
// The transport limiter can zero individual components and corrupt near-wall vorticity.
export function planarFiles(raw:PlanarCase):Record<string,string>{
 const c=PlanarCase.parse(raw),speed=Math.max(.001,...c.boundaries.flatMap(b=>b.type==="velocity-inlet"?[Math.hypot(...b.velocity)]:[])),dt=Math.min(c.duration/100,c.meshSize/speed*.05,c.motion?1/(c.motion.frequencyHz*200):Infinity);
 const moving=c.motion?c.bodies.find(b=>b.name===c.motion!.body)!.boundary:null;
 const field=(name:string,dim:string,value:string,vector:boolean)=>header(name,vector?"volVectorField":"volScalarField")+`dimensions ${dim}; internalField uniform ${value}; boundaryField { ${c.boundaries.map(b=>{
  const bc=b.type==="symmetry"?"type symmetry;":vector?(b.type==="wall"?(b.name===moving?"type movingWallVelocity; value uniform (0 0 0);":"type noSlip;"):b.type==="velocity-inlet"?`type fixedValue; value uniform (${b.velocity[0]} ${b.velocity[1]} 0);`:"type inletOutlet; inletValue uniform (0 0 0); value uniform (0 0 0);"):(b.type==="pressure-outlet"?`type fixedValue; value uniform ${b.pressure/c.region.density};`:"type zeroGradient;");return `${b.name} { ${bc} }`;
 }).join(" ")} frontAndBack {type empty;} }`;
 return {
 "system/controlDict":header("controlDict")+`application pimpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime ${c.duration}; deltaT ${dt}; adjustTimeStep yes; maxCo 0.5; maxDeltaT ${Math.min(c.duration/c.frames,c.motion?1/(c.motion.frequencyHz*100):Infinity)}; writeControl adjustableRunTime; writeInterval ${c.duration/c.frames}; purgeWrite 0; writeFormat ascii; writePrecision 10; writeCompression off; timeFormat general; timePrecision 10; runTimeModifiable false; functions { vorticity { type vorticity; libs (fieldFunctionObjects); field U; executeControl writeTime; writeControl writeTime; } }`,
 "system/fvSchemes":header("fvSchemes")+`ddtSchemes {default backward;} gradSchemes {default cellLimited Gauss linear 1; "curl(U)" leastSquares;} divSchemes {default none; div(phi,U) Gauss linearUpwind grad(U); div((nuEff*dev2(T(grad(U))))) Gauss linear;} laplacianSchemes {default Gauss linear limited 0.5;} interpolationSchemes {default linear;} snGradSchemes {default limited 0.5;} fluxRequired {default no; p;}`,
 "system/fvSolution":header("fvSolution")+`solvers {${c.motion?"pcorr {solver PCG; preconditioner DIC; tolerance 1e-9; relTol 0;} pcorrFinal {$pcorr; relTol 0;} ":""}cellDisplacement {solver PCG; preconditioner DIC; tolerance 1e-10; relTol 0;} p {solver GAMG; smoother DICGaussSeidel; tolerance 1e-8; relTol 0.05;} pFinal {$p; relTol 0;} U {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0.05;} UFinal {$U; relTol 0;}} PIMPLE {${c.motion?"correctPhi yes; checkMeshCourantNo yes; ":""}nOuterCorrectors 2; nCorrectors 2; nNonOrthogonalCorrectors 2;}`,
 "constant/transportProperties":header("transportProperties")+`transportModel Newtonian; nu ${c.region.nu};`,
 "constant/turbulenceProperties":header("turbulenceProperties")+"simulationType laminar;",
 ...(c.motion?{
 "constant/dynamicMeshDict":header("dynamicMeshDict")+`dynamicFvMesh dynamicMotionSolverFvMesh; motionSolverLibs (fvMotionSolvers); solver displacementLaplacian; displacementLaplacianCoeffs { diffusivity quadratic inverseDistance (${moving}); }`,
 "0/pointDisplacement":header("pointDisplacement","pointVectorField")+`dimensions [0 1 0 0 0 0 0]; internalField uniform (0 0 0); boundaryField { ${c.boundaries.map(b=>`${b.name} { ${b.name===moving?`type solidBodyMotionDisplacement; solidBodyMotionFunction oscillatingRotatingMotion; oscillatingRotatingMotionCoeffs { origin (${c.motion!.pivot[0]} ${c.motion!.pivot[1]} 0); amplitude (0 0 ${c.motion!.amplitudeDegrees}); omega ${2*Math.PI*c.motion!.frequencyHz}; }`:"type fixedValue; value uniform (0 0 0);"} }`).join(" ")} frontAndBack {type empty;} }`,
 }:{}),
 "0/U":field("U","[0 1 -1 0 0 0 0]",`(${c.initialVelocity[0]} ${c.initialVelocity[1]} 0)`,true),
 "0/p":field("p","[0 2 -2 0 0 0 0]","0",false),
 };
}
