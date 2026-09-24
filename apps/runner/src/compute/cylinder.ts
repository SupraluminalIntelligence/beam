import { CylinderCase } from "@beam/contracts";
const header=(object:string,klass="dictionary")=>`FoamFile { version 2.0; format ascii; class ${klass}; object ${object}; }\n`;
/** Eight body-fitted sectors, then eight graded blocks to a rectangular far field. */
export function cylinderFiles(raw:CylinderCase):Record<string,string>{
 const c=CylinderCase.parse(raw),D=c.diameter,U=c.velocity,tau=D/U;
 const square=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
 const far=[[15,0],[15,4],[0,4],[-5,4],[-5,0],[-5,-4],[0,-4],[15,-4]];
 const xy=Array.from({length:8},(_,i)=>[.5*Math.cos(i*Math.PI/4),.5*Math.sin(i*Math.PI/4)]).concat(square,far);
 const vertices=[0,.1].flatMap(z=>xy.map(p=>`(${p[0]!*D} ${p[1]!*D} ${z*D})`));
 const blocks:string[]=[],edges:string[]=[],front:string[]=[],cylinder:string[]=[],inlet:string[]=[],outlet:string[]=[],sides:string[]=[];
 for(let ring=0;ring<2;ring++)for(let i=0;i<8;i++){
  const j=(i+1)%8,a=ring*8+i,b=(ring+1)*8+i,d=ring*8+j,e=(ring+1)*8+j;
  blocks.push(`hex (${a} ${b} ${e} ${d} ${a+24} ${b+24} ${e+24} ${d+24}) (${ring?48:10} 12 1) simpleGrading (2 1 1)`);
  front.push(`(${a} ${d} ${e} ${b})`,`(${a+24} ${b+24} ${e+24} ${d+24})`);
  if(!ring)cylinder.push(`(${a} ${a+24} ${d+24} ${d})`);
  else (i===0||i===7?outlet:i===3||i===4?inlet:sides).push(`(${b} ${e} ${e+24} ${b+24})`);
 }
 for(let i=0;i<8;i++)for(const z of [0,1]){const angle=(i+.5)*Math.PI/4;edges.push(`arc ${i+z*24} ${(i+1)%8+z*24} (${.5*D*Math.cos(angle)} ${.5*D*Math.sin(angle)} ${z*.1*D})`);}
 const patch=(name:string,type:string,faces:string[])=>`${name} { type ${type}; faces (${faces.join(" ")}); }`;
 const field=(name:string,dim:string,value:string,bc:string,vector=false)=>header(name,vector?"volVectorField":"volScalarField")+`dimensions ${dim}; internalField uniform ${value}; boundaryField { ${bc} farfield {type symmetry;} frontAndBack {type empty;} }`;
 const files:Record<string,string> = {
  "system/blockMeshDict":header("blockMeshDict")+`scale 1; vertices (${vertices.join(" ")}); blocks (${blocks.join(" ")}); edges (${edges.join(" ")}); boundary (${patch("cylinder","wall",cylinder)} ${patch("inlet","patch",inlet)} ${patch("outlet","patch",outlet)} ${patch("farfield","symmetry",sides)} ${patch("frontAndBack","empty",front)}); mergePatchPairs ();`,
  "system/controlDict":header("controlDict")+`application pimpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime ${c.duration*tau}; deltaT ${.005*tau}; adjustTimeStep yes; maxCo 0.7; maxDeltaT ${.04*tau}; writeControl adjustableRunTime; writeInterval ${c.duration*tau/100}; purgeWrite 0; writeFormat ascii; writePrecision 9; writeCompression off; timeFormat general; timePrecision 10; runTimeModifiable false; functions { vorticity { type vorticity; libs (fieldFunctionObjects); field U; executeControl writeTime; writeControl writeTime; } }`,
  "system/fvSchemes":header("fvSchemes")+`ddtSchemes {default backward;} gradSchemes {default Gauss linear;} divSchemes {default none; div(phi,U) Gauss linearUpwind grad(U); div((nuEff*dev2(T(grad(U))))) Gauss linear;} laplacianSchemes {default Gauss linear corrected;} interpolationSchemes {default linear;} snGradSchemes {default corrected;} fluxRequired {default no; p;}`,
  "system/fvSolution":header("fvSolution")+`solvers {p {solver GAMG; smoother DICGaussSeidel; tolerance 1e-7; relTol 0.05;} pFinal {$p; relTol 0;} U {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0.05;} UFinal {$U; relTol 0;}} PIMPLE {nOuterCorrectors 1; nCorrectors 2; nNonOrthogonalCorrectors 1;}`,
  "constant/transportProperties":header("transportProperties")+`transportModel Newtonian; nu ${U*D/c.reynolds};`,
  "constant/turbulenceProperties":header("turbulenceProperties")+"simulationType laminar;",
  // A small, declared initial transverse perturbation breaks perfect numerical symmetry.
  "0/U":field("U","[0 1 -1 0 0 0 0]",`(${U} ${.01*U} 0)`,`inlet {type fixedValue; value uniform (${U} 0 0);} outlet {type zeroGradient;} cylinder {type noSlip;}`,true),
  "0/p":field("p","[0 2 -2 0 0 0 0]","0","inlet {type zeroGradient;} outlet {type fixedValue; value uniform 0;} cylinder {type zeroGradient;}"),
 };
 if(c.version===2)files["system/blockMeshDict"]=wakeMesh(D);
 return files;
}
/** Read actual front faces from the generated OpenFOAM mesh, preserving cell addressing. */
export function meshPolygons(pointsText:string,facesText:string,ownerText:string,cells:number):[number,number][][]{
 const body=(s:string)=>{const clean=s.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");const m=clean.match(/}\s*\d+\s*\(([\s\S]*)\)\s*$/);if(!m)throw new Error("Invalid ASCII mesh list");return m[1]!;};
 const points=[...body(pointsText).matchAll(/\(([^()]+)\)/g)].map(m=>m[1]!.trim().split(/\s+/).map(Number));
 const faces=[...body(facesText).matchAll(/\d+\(([^()]+)\)/g)].map(m=>m[1]!.trim().split(/\s+/).map(Number));
 const owners=body(ownerText).trim().split(/\s+/).map(Number),polygons:[number,number][][]=Array.from({length:cells},()=>[]);
 if(owners.length!==faces.length)throw new Error("Mesh addressing differs");
 faces.forEach((face,i)=>{const pts=face.map(v=>points[v]!);if(pts.every(p=>Math.abs(p[2]!)<1e-12)){const cell=owners[i]!;if(cell<0||cell>=cells)throw new Error("Invalid cell index");polygons[cell]=pts.map(p=>[p[0]!,p[1]!] as [number,number]);}});
 if(polygons.some(p=>p.length<3))throw new Error("Missing 2-D cell face");return polygons;
}

/** Cartesian wake blocks retain cross-stream resolution far downstream. */
function wakeMesh(D:number){
 const points:[number,number][]=[],index=new Map<string,number>();
 const vertex=(x:number,y:number)=>{const key=`${x},${y}`;let i=index.get(key);if(i===undefined){i=points.length;points.push([x,y]);index.set(key,i);}return i;};
 const quads:{v:number[];nx:number;ny:number;gx:number;gy:number}[]=[],arcs:{a:number;b:number;x:number;y:number}[]=[];
 const square=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
 const inner=Array.from({length:8},(_,i)=>vertex(.5*Math.cos(i*Math.PI/4),.5*Math.sin(i*Math.PI/4)));
 const outer=square.map(p=>vertex(p[0]!,p[1]!));
 for(let i=0;i<8;i++){const j=(i+1)%8;quads.push({v:[inner[i]!,outer[i]!,outer[j]!,inner[j]!],nx:10,ny:10,gx:2,gy:1});arcs.push({a:inner[i]!,b:inner[j]!,x:.5*Math.cos((i+.5)*Math.PI/4),y:.5*Math.sin((i+.5)*Math.PI/4)});}
 const xs=[-5,-1,0,1,15],ys=[-4,-1,0,1,4],nx=[24,10,10,80],ny=[18,10,10,18];
 for(let y=0;y<4;y++)for(let x=0;x<4;x++){
  if((x===1||x===2)&&(y===1||y===2))continue;
  quads.push({v:[vertex(xs[x]!,ys[y]!),vertex(xs[x+1]!,ys[y]!),vertex(xs[x+1]!,ys[y+1]!),vertex(xs[x]!,ys[y+1]!)],nx:nx[x]!,ny:ny[y]!,gx:x===0?1/3:1,gy:y===0?1/3:y===3?3:1});
 }
 const n=points.length,edgeUses=new Map<string,{a:number;b:number;count:number}>();
 for(const {v} of quads)for(let i=0;i<4;i++){const a=v[i]!,b=v[(i+1)%4]!,key=[a,b].sort((a,b)=>a-b).join();const prior=edgeUses.get(key);if(prior)prior.count++;else edgeUses.set(key,{a,b,count:1});}
 const patch:Record<string,string[]>={inlet:[],outlet:[],farfield:[],cylinder:[],frontAndBack:[]};
 for(const e of edgeUses.values()){if(e.count!==1)continue;const a=points[e.a]!,b=points[e.b]!;const name=a[0]===-5&&b[0]===-5?"inlet":a[0]===15&&b[0]===15?"outlet":Math.abs(a[1])===4&&a[1]===b[1]?"farfield":"cylinder";patch[name]!.push(`(${e.a} ${e.b} ${e.b+n} ${e.a+n})`);}
 for(const {v} of quads){patch.frontAndBack!.push(`(${v.slice().reverse().join(" ")})`,`(${v.map(i=>i+n).join(" ")})`);}
 return header("blockMeshDict")+`scale 1; vertices (${[0,.1].flatMap(z=>points.map(p=>`(${p[0]*D} ${p[1]*D} ${z*D})`)).join(" ")}); blocks (${quads.map(q=>`hex (${q.v.concat(q.v.map(i=>i+n)).join(" ")}) (${q.nx} ${q.ny} 1) simpleGrading (${q.gx} ${q.gy} 1)`).join(" ")}); edges (${arcs.flatMap(a=>[0,1].map(z=>`arc ${a.a+z*n} ${a.b+z*n} (${a.x*D} ${a.y*D} ${z*.1*D})`)).join(" ")}); boundary (${Object.entries(patch).map(([name,faces])=>`${name} { type ${name==="cylinder"?"wall":name==="frontAndBack"?"empty":name==="farfield"?"symmetry":"patch"}; faces (${faces.join(" ")}); }`).join(" ")}); mergePatchPairs ();`;
}
