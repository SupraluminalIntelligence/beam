import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Domain3DCase, Domain3DFields, Domain3DForces, Domain3DMeshView, Domain3DStreamlines, SimulationJob, SimulationReport, OPENFOAM_IMAGE, MAX_COMPUTE_FILE_BYTES, ahmedSurface, closeAndOrient, decodeModel, encodeStl, measureModel, modelInputPath, modelMatches, placeSurface, backgroundCells, bodyBounds, bodyLevel, canonicalMeshKey, estimateDomain3dCells, frontalArea, insideBody, locationInMesh, meshKey, type Body3D, type Point3 } from "@beam/contracts";
const header=(object:string,klass="dictionary")=>`FoamFile { version 2.0; format ascii; class ${klass}; object ${object}; }\n`;
const v=(p:readonly number[])=>`(${p.join(" ")})`;
const axis={x:0,y:1,z:2} as const;
/** Local 3-D limits. The contract estimate is a guide; these apply to the generated mesh. */
export const DOMAIN3D_MAX_CELLS=300_000;
export const domain3dProcesses=(cells:number)=>cells<30_000?1:4;
export const inletSpeed=(c:Domain3DCase)=>Math.max(1e-6,...c.boundaries.flatMap(b=>b.type==="velocity-inlet"?[Math.hypot(...b.velocity)]:[]));
export function turbulenceInlet(c:Domain3DCase){
 if(c.turbulence.model!=="kOmegaSST")return null;
 const k=1.5*(inletSpeed(c)*c.turbulence.intensity)**2,omega=Math.sqrt(k)/(0.09**.25*c.turbulence.lengthScale);
 return{k,omega};
}
/** Cutting exactly on a background or refined grid face is degenerate; nudge by a tiny fraction of a cell. */
export function sliceOffset(c:Domain3DCase,s:{normal:"x"|"y"|"z";offset:number}){
 const i=axis[s.normal],step=c.meshSize/16,rel=(s.offset-c.domain.min[i])/step;
 return Math.abs(rel-Math.round(rel))<1e-3?s.offset+step*.0137:s.offset;
}
function searchable(b:Body3D){
 if(b.shape==="ahmed"||b.shape==="model")return`type triSurfaceMesh; file "body_${b.name}.stl";`;
 return b.shape==="sphere"?`type searchableSphere; centre ${v(b.centre)}; radius ${b.radius};`:b.shape==="box"?`type searchableBox; min ${v(b.min)}; max ${v(b.max)};`:`type searchableCylinder; point1 ${v(b.start)}; point2 ${v(b.end)}; radius ${b.radius};`;
}
/** ASCII STL of a triangulated body surface, read by snappyHexMesh as a triSurfaceMesh. */
export function stlText(name:string,s:{points:number[];triangles:number[]}){
 const p=(i:number)=>[s.points[3*i]!,s.points[3*i+1]!,s.points[3*i+2]!];const out=[`solid ${name}`];
 for(let t=0;t<s.triangles.length;t+=3){
  const [a,b,c]=[p(s.triangles[t]!),p(s.triangles[t+1]!),p(s.triangles[t+2]!)] as number[][],u=b!.map((x,i)=>x-a![i]!),w=c!.map((x,i)=>x-a![i]!);
  const n=[u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!],m=Math.hypot(...n)||1;
  out.push(` facet normal ${n.map(x=>x/m).join(" ")}`,"  outer loop",...[a,b,c].map(q=>`   vertex ${q!.join(" ")}`),"  endloop"," endfacet");
 }
 return out.concat(`endsolid ${name}`,"").join("\n");
}
/**
 * An imported body's stored surface, checked against the measurements the study was validated with,
 * then placed in world coordinates as the binary STL snappyHexMesh reads.
 */
export async function writeModelSurfaces(c:Domain3DCase,dir:string){
 for(const b of c.bodies){
  if(b.shape!=="model")continue;
  const {surface,shells}=closeAndOrient(decodeModel(await readFile(join(dir,modelInputPath(b)))));
  if(!modelMatches(measureModel(surface,shells),b.model))throw new Error(`Model ${b.model.file} does not match the surface body ${b.name} was set up with; import it again`);
  await mkdir(join(dir,"constant","triSurface"),{recursive:true});
  await writeFile(join(dir,"constant","triSurface",`body_${b.name}.stl`),encodeStl(placeSurface(b,surface),`body_${b.name}`));
 }
}
/** Body loads are reported as coefficients only for a tunnel-style flow along +x. */
export function flowAlongX(c:Domain3DCase){return c.boundaries.every(b=>b.type!=="velocity-inlet"||(b.velocity[0]>0&&Math.hypot(b.velocity[1],b.velocity[2])<=1e-9*b.velocity[0]));}
function bodiesBounds(c:Domain3DCase){
 const all=c.bodies.map(bodyBounds);
 return{min:[0,1,2].map(i=>Math.min(...all.map(b=>b.min[i]!))) as Point3,max:[0,1,2].map(i=>Math.max(...all.map(b=>b.max[i]!))) as Point3};
}
/** Force reference values: combined frontal area, streamwise body extent and the bodies' centre. */
export function forceReference(c:Domain3DCase){
 const b=bodiesBounds(c);
 return{area:c.bodies.reduce((s,x)=>s+frontalArea(x),0),length:b.max[0]-b.min[0],centre:[0,1,2].map(i=>(b.min[i]!+b.max[i]!)/2) as Point3};
}
/** A rake of streamline seeds just upstream of the bodies, spanning a margin around them. */
export function streamlineSeeds(c:Domain3DCase):Point3[]{
 if(!c.bodies.length||!flowAlongX(c))return[];
 const b=bodiesBounds(c),{min,max}=c.domain,h=c.meshSize,size=[0,1,2].map(i=>b.max[i]!-b.min[i]!);
 const x=Math.max(min[0]+h,b.min[0]-.15*size[0]!),span=(i:1|2,below:number,above:number,n:number)=>{const lo=Math.max(min[i]+h/4,b.min[i]-below*size[i]!),hi=Math.min(max[i]-h/4,b.max[i]+above*size[i]!);return Array.from({length:n},(_,k)=>lo+(hi-lo)*k/(n-1));};
 const seeds:Point3[]=[];
 for(const y of span(1,.3,.3,9))for(const z of span(2,.15,.4,7)){const p:Point3=[x,y,z];if(!c.bodies.some(body=>insideBody(body,p)))seeds.push(p);}
 return seeds;
}
/**
 * An imported model refines one level further where its surface curves sharply (resolveFeatureAngle),
 * so thin parts such as pins or mirrors get cells across them. Built-in shapes keep a single level.
 */
export const surfaceMaxLevel=(c:Domain3DCase,b:Body3D)=>b.shape==="model"?bodyLevel(c,b)+1:bodyLevel(c,b);
const patchType=(c:Domain3DCase,name:string)=>{const t=c.boundaries.find(b=>b.name===name)!.type;return t==="wall"?"wall":t==="symmetry"?"symmetry":"patch";};
export function usesSnappy(c:Domain3DCase){return c.bodies.length>0||(c.refinements??[]).length>0;}
/** Complete OpenFOAM dictionaries for a composable 3-D domain. SI units; solver pressure is kinematic. */
export function domain3dFiles(raw:Domain3DCase,processes=1):Record<string,string>{
 const c=Domain3DCase.parse(raw),{min,max}=c.domain,[nx,ny,nz]=backgroundCells(c),refinements=c.refinements??[];
 const corners:Point3[]=[[min[0],min[1],min[2]],[max[0],min[1],min[2]],[max[0],max[1],min[2]],[min[0],max[1],min[2]],[min[0],min[1],max[2]],[max[0],min[1],max[2]],[max[0],max[1],max[2]],[min[0],max[1],max[2]]];
 const faceVertices={xMin:"(0 4 7 3)",xMax:"(1 2 6 5)",yMin:"(0 1 5 4)",yMax:"(3 7 6 2)",zMin:"(0 3 2 1)",zMax:"(4 5 6 7)"} as const;
 const groups=new Map<string,string[]>();
 for(const [face,name] of Object.entries(c.domain.faces))groups.set(name,[...(groups.get(name)??[]),faceVertices[face as keyof typeof faceVertices]]);
 const maxLevel=Math.max(0,...refinements.map(r=>r.level)),speed=inletSpeed(c),dt=0.2*c.meshSize/2**maxLevel/speed,interval=c.duration/c.frames;
 const turbulent=c.turbulence.model==="kOmegaSST",tin=turbulenceInlet(c);
 const bodyPatches=[...new Set(c.bodies.map(b=>b.boundary))];
 const field=(name:string,klass:string,dim:string,initial:string,bc:(b:Domain3DCase["boundaries"][number])=>string)=>header(name,klass)+`dimensions ${dim};\ninternalField uniform ${initial};\nboundaryField {\n${c.boundaries.map(b=>` ${b.name} { ${b.type==="symmetry"?"type symmetry;":bc(b)} }`).join("\n")}\n}\n`;
 const wallPatches=bodyPatches.concat(c.boundaries.filter(b=>b.type==="wall"&&!bodyPatches.includes(b.name)).map(b=>b.name));
 const reference=c.bodies.length?forceReference(c):null,loads=reference?`rho rhoInf; rhoInf ${c.region.density}; CofR ${v(reference.centre)}; patches (${bodyPatches.join(" ")}); writeControl timeStep; writeInterval 1; log false;`:"";
 const forceFunctions=reference?` forces { type forces; libs (forces); ${loads} }\n${flowAlongX(c)?` forceCoeffs { type forceCoeffs; libs (forces); ${loads} liftDir (0 0 1); dragDir (1 0 0); pitchAxis (0 1 0); magUInf ${speed}; lRef ${reference.length}; Aref ${reference.area}; }\n`:""}`:"";
 const sampled=(interpolate:boolean)=>`surfaces {\n${c.slices.map(s=>{const n=[0,0,0];n[axis[s.normal]]=1;const p=[(min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2];p[axis[s.normal]]=sliceOffset(c,s);return`  slice_${s.name} { type cuttingPlane; planeType pointAndNormal; pointAndNormalDict { point ${v(p)}; normal ${v(n)}; } interpolate ${interpolate}; }`;}).join("\n")}\n${wallPatches.map(p=>`  wall_${p} { type patch; patches (${p}); interpolate ${interpolate}; }`).join("\n")}\n }`;
 const surfaceFormat="surfaceFormat vtk; formatOptions { vtk { format ascii; legacy true; precision 7; } }";
 const files:Record<string,string>={
  "system/blockMeshDict":header("blockMeshDict")+`scale 1;\nvertices (${corners.map(v).join(" ")});\nblocks (hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1));\nedges ();\nboundary (\n${[...groups].map(([name,faces])=>` ${name} { type ${patchType(c,name)}; faces (${faces.join(" ")}); }`).join("\n")}\n);\nmergePatchPairs ();\n`,
  "system/controlDict":header("controlDict")+`application pimpleFoam;\nstartFrom startTime; startTime 0; stopAt endTime; endTime ${c.duration};\ndeltaT ${dt}; adjustTimeStep yes; maxCo 0.9; maxDeltaT ${interval};\nwriteControl adjustableRunTime; writeInterval ${c.duration}; purgeWrite 0;\nwriteFormat binary; writePrecision 10; writeCompression on; timeFormat general; timePrecision 10; runTimeModifiable false;\nfunctions {\n sampled { type surfaces; libs (sampling); writeControl adjustableRunTime; writeInterval ${interval}; ${surfaceFormat} fields (U p); interpolationScheme cellPoint;\n ${sampled(true)}\n }\n minMax { type fieldMinMax; libs (fieldFunctionObjects); writeControl timeStep; writeInterval 1; mode magnitude; log false; fields (U p${turbulent?" nut":""}); }\n${forceFunctions}}\n`,
  "system/meshViewDict":header("meshViewDict")+`functions {\n meshView { type surfaces; libs (sampling); ${surfaceFormat} fields (p); interpolationScheme cell;\n ${sampled(false)}\n }\n}\n`,
  "system/fvSchemes":header("fvSchemes")+`ddtSchemes { default Euler; }\ngradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; grad(k) cellLimited Gauss linear 1; grad(omega) cellLimited Gauss linear 1; }\ndivSchemes { default none; div(phi,U) Gauss linearUpwind grad(U); div(phi,k) Gauss upwind; div(phi,omega) Gauss upwind; div((nuEff*dev2(T(grad(U))))) Gauss linear; }\nlaplacianSchemes { default Gauss linear limited corrected 0.5; }\ninterpolationSchemes { default linear; }\nsnGradSchemes { default limited corrected 0.5; }\nwallDist { method meshWave; }\n`,
  "system/fvSolution":header("fvSolution")+`solvers {\n p { solver GAMG; smoother GaussSeidel; tolerance 1e-6; relTol 0.05; }\n pFinal { solver GAMG; smoother GaussSeidel; tolerance 1e-6; relTol 0; }\n "(U|k|omega)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0.1; }\n "(U|k|omega)Final" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0; }\n}\nPIMPLE { momentumPredictor yes; nOuterCorrectors 1; nCorrectors 2; nNonOrthogonalCorrectors 1; pRefCell 0; pRefValue 0; }\nrelaxationFactors { equations { ".*" 1; } }\n`,
  "system/decomposeParDict":header("decomposeParDict")+`numberOfSubdomains ${processes};\nmethod scotch;\n`,
  "constant/transportProperties":header("transportProperties")+`transportModel Newtonian;\nnu ${c.region.nu};\n`,
  "constant/turbulenceProperties":header("turbulenceProperties")+(turbulent?"simulationType RAS;\nRAS { RASModel kOmegaSST; turbulence on; printCoeffs on; }\n":"simulationType laminar;\n"),
  "0/U":field("U","volVectorField","[0 1 -1 0 0 0 0]",v(c.initialVelocity),b=>b.type==="velocity-inlet"?`type fixedValue; value uniform ${v(b.velocity)};`:b.type==="pressure-outlet"?"type inletOutlet; inletValue uniform (0 0 0); value uniform (0 0 0);":"type noSlip;"),
  "0/p":field("p","volScalarField","[0 2 -2 0 0 0 0]","0",b=>b.type==="pressure-outlet"?`type fixedValue; value uniform ${b.pressure/c.region.density};`:"type zeroGradient;"),
 };
 for(const b of c.bodies)if(b.shape==="ahmed")files[`constant/triSurface/body_${b.name}.stl`]=stlText(`body_${b.name}`,ahmedSurface(b));
 const seeds=streamlineSeeds(c);
 if(seeds.length)files["system/streamDict"]=header("streamDict")+`functions {\n streamLines { type streamLine; libs (fieldFunctionObjects); setFormat vtk; formatOptions { vtk { format ascii; legacy true; precision 7; } } U U; direction forward; fields (U p); lifeTime 20000; nSubCycle 4; cloud particleTracks; seedSampleSet { type cloud; axis xyz; points (${seeds.map(v).join(" ")}); } }\n}\n`;
 if(tin){
  const turb=(n:"k"|"omega",dim:string,value:number,wall:string)=>field(n,"volScalarField",dim,String(value),b=>b.type==="velocity-inlet"?`type fixedValue; value uniform ${value};`:b.type==="pressure-outlet"?`type inletOutlet; inletValue uniform ${value}; value uniform ${value};`:`type ${wall}; value uniform ${value};`);
  files["0/k"]=turb("k","[0 2 -2 0 0 0 0]",tin.k,"kqRWallFunction");
  files["0/omega"]=turb("omega","[0 0 -1 0 0 0 0]",tin.omega,"omegaWallFunction");
  files["0/nut"]=field("nut","volScalarField","[0 2 -1 0 0 0 0]","0",b=>b.type==="wall"?"type nutkWallFunction; value uniform 0;":"type calculated; value uniform 0;");
 }
 if(usesSnappy(c)){
  const geometry=[...c.bodies.map(b=>` body_${b.name} { ${searchable(b)} }`),...refinements.flatMap(r=>r.kind==="box"?[` refine_${r.name} { type searchableBox; min ${v(r.min)}; max ${v(r.max)}; }`]:[])];
  const regions=[...c.bodies.flatMap(b=>{const d=refinements.filter(r=>r.kind==="body"&&r.body===b.name&&r.distance>0).map(r=>r.kind==="body"?`(${r.distance} ${r.level})`:"");return d.length?[`  body_${b.name} { mode distance; levels (${d.join(" ")}); }`]:[];}),...refinements.flatMap(r=>r.kind==="box"?[`  refine_${r.name} { mode inside; levels ((1e15 ${r.level})); }`]:[])];
  files["system/snappyHexMeshDict"]=header("snappyHexMeshDict")+`castellatedMesh true;\nsnap ${c.bodies.length>0};\naddLayers false;\ngeometry {\n${geometry.join("\n")}\n}\ncastellatedMeshControls {\n maxLocalCells 2000000; maxGlobalCells 4000000; minRefinementCells 0; maxLoadUnbalance 0.1; nCellsBetweenLevels 3;\n features ();\n refinementSurfaces {\n${c.bodies.map(b=>`  body_${b.name} { level (${bodyLevel(c,b)} ${surfaceMaxLevel(c,b)}); patchInfo { type wall; } }`).join("\n")}\n }\n resolveFeatureAngle 30;\n refinementRegions {\n${regions.join("\n")}\n }\n locationInMesh ${v(locationInMesh(c))};\n allowFreeStandingZoneFaces true;\n}\nsnapControls { nSmoothPatch 3; tolerance 2.0; nSolveIter 50; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false; }\naddLayersControls { relativeSizes true; layers {} expansionRatio 1.2; finalLayerThickness 0.5; minThickness 0.1; nGrow 0; featureAngle 60; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }\nmeshQualityControls { #includeEtc "caseDicts/mesh/generation/meshQualityDict.cfg" }\nmergeTolerance 1e-6;\n`;
  files["system/createPatchDict"]=header("createPatchDict")+`pointSync false;\npatches (\n${bodyPatches.map(p=>` { name ${p}; patchInfo { type wall; } constructFrom patches; patches (${c.bodies.filter(b=>b.boundary===p).map(b=>`body_${b.name}`).join(" ")}); }`).join("\n")}\n);\n`;
 }
 return files;
}
export const domain3dMeshCommands=(c:Domain3DCase)=>[
 "blockMesh > mesh.log 2>&1",
 ...(usesSnappy(c)?["snappyHexMesh -overwrite > snappy.log 2>&1",...(c.bodies.length?["createPatch -overwrite > patch.log 2>&1"]:[])]:[]),
 "checkMesh > check.log 2>&1","cat check.log","grep -q 'Mesh OK' check.log",
 "checkMesh -allTopology -allGeometry > check-all.log 2>&1 || true",
 "postProcess -dict system/meshViewDict -time 0 > meshview.log 2>&1",
];
export function domain3dSolveCommands(processes:number,streamlines=false){
 const mpi=processes>1?`mpirun --allow-run-as-root --oversubscribe -np ${processes} `:"",parallel=processes>1?" -parallel":"";
 return[
  "checkMesh > check.log 2>&1","cat check.log","grep -q 'Mesh OK' check.log",
  "echo BEAM_STAGE solving",
  ...(processes>1?["decomposePar -force > decompose.log 2>&1"]:[]),
  `${mpi}pimpleFoam${parallel} > solve.log 2>&1`,
  ...(processes>1?["reconstructPar -latestTime > reconstruct.log 2>&1","rm -rf processor*"]:[]),
  "echo BEAM_STAGE exporting",
  // Streamlines are a picture of the final field; a tracking failure must not lose the solve.
  ...(streamlines?["postProcess -dict system/streamDict -latestTime -fields '(U p)' > streamlines.log 2>&1 || true"]:[]),
 ];
}

/** Legacy ASCII VTK polydata written by OpenFOAM's vtk surface and set writers (polygons or polylines). */
export function parseVtkSurface(text:string){
 const tokens=text.split(/\s+/).filter(Boolean);let at=0;
 const find=(word:string)=>{while(at<tokens.length&&tokens[at]!==word)at++;if(at>=tokens.length)throw new Error(`VTK surface lacks ${word}`);at++;};
 find("POINTS");const nPoints=Number(tokens[at++]);at++;
 const points=new Array<number>(nPoints*3);for(let i=0;i<nPoints*3;i++)points[i]=Number(tokens[at++]);
 const counts:number[]=[],indices:number[]=[];
 while(at<tokens.length&&tokens[at]!=="POLYGONS"&&tokens[at]!=="LINES")at++;
 if(tokens[at]==="POLYGONS"||tokens[at]==="LINES"){
  at++;
  if(tokens[at+2]==="OFFSETS"){ // VTK 5.1 layout: offsets then connectivity
   const nOffsets=Number(tokens[at]);at+=2;at+=2;const offsets:number[]=[];for(let i=0;i<nOffsets;i++)offsets.push(Number(tokens[at++]));
   while(tokens[at]!=="CONNECTIVITY")at++;at+=2;
   for(let i=0;i+1<offsets.length;i++){counts.push(offsets[i+1]!-offsets[i]!);for(let k=offsets[i]!;k<offsets[i+1]!;k++)indices.push(Number(tokens[at++]));}
  }else{
   const nFaces=Number(tokens[at]);at+=2;
   for(let f=0;f<nFaces;f++){const n=Number(tokens[at++]);counts.push(n);for(let k=0;k<n;k++)indices.push(Number(tokens[at++]));}
  }
 }
 const fields:Record<string,{location:"point"|"cell";components:number;values:number[]}>={};
 let location:"point"|"cell"="point";
 for(;at<tokens.length;at++){
  const t=tokens[at];
  if(t==="POINT_DATA"||t==="CELL_DATA"){location=t==="POINT_DATA"?"point":"cell";at++;continue;}
  if(t==="FIELD"){const n=Number(tokens[at+2]);at+=3;for(let f=0;f<n;f++){const name=tokens[at++]!,components=Number(tokens[at++]),count=Number(tokens[at++]);at++;const values=new Array<number>(components*count);for(let i=0;i<components*count;i++)values[i]=Number(tokens[at++]);fields[name]={location,components,values};}at--;}
 }
 if(!points.every(Number.isFinite)||indices.some(i=>!Number.isInteger(i)||i<0||i>=nPoints))throw new Error("Invalid VTK surface geometry");
 for(const f of Object.values(fields))if(!f.values.every(Number.isFinite))throw new Error("Non-finite VTK surface field");
 return{points,counts,indices,fields};
}
/** Fan triangulation of convex cut and patch faces. */
export function triangulateFaces(counts:number[],indices:number[]){
 const triangles:number[]=[];let at=0;
 for(const n of counts){for(let k=1;k+1<n;k++)triangles.push(indices[at]!,indices[at+k]!,indices[at+k+1]!);at+=n;}
 return triangles;
}

type Container=(script:string,resources:{cpus:number;memory:string})=>Promise<void>;
type Residuals=(log:string,transient?:boolean)=>{iteration:number;field:string;initial:number;final:number}[];
const exec=promisify(execFile);
const metric=(text:string,re:RegExp)=>{const found=text.match(re);return found?Number(found[1]):null;};
const surfaceOrder=(c:Domain3DCase)=>{const bodyPatches=[...new Set(c.bodies.map(b=>b.boundary))];return[...c.slices.map(s=>({file:`slice_${s.name}`,name:s.name,kind:"slice" as const})),...bodyPatches.concat(c.boundaries.filter(b=>b.type==="wall"&&!bodyPatches.includes(b.name)).map(b=>b.name)).map(p=>({file:`wall_${p}`,name:p,kind:"wall" as const}))];};
function meshStats(check:string){
 const cells=Number(check.match(/cells:\s+(\d+)/)?.[1]);
 const cellTypes:Record<string,number>={};for(const k of ["hexahedra","prisms","wedges","pyramids","tet wedges","tetrahedra","polyhedra"]){const n=check.match(new RegExp(`^\\s*${k}:\\s+(\\d+)`,"m"));if(n)cellTypes[k]=Number(n[1]);}
 return{cells,cellTypes,maxNonOrthogonality:metric(check,/non-orthogonality Max:\s*([\d.eE+-]+)/i),maxSkewness:metric(check,/Max skewness\s*=\s*([\d.eE+-]+)/i)};
}
function geometryChecks(all:string){
 const failed=all.match(/Failed (\d+) mesh checks/);if(!failed)return /Mesh OK/.test(all)?"checkMesh -allGeometry -allTopology: passed":"checkMesh -allGeometry -allTopology: not evaluated";
 const notes=all.split("\n").filter(l=>l.includes("***")).map(l=>l.replace(/\s+/g," ").replace(/^ ?\*+/,"").trim()).slice(0,3).join("; ");
 return`checkMesh -allGeometry -allTopology (advisory): ${failed[1]} failed · ${notes}`.slice(0,400);
}
/** Archive entries must stay within the expected polyMesh snapshot. */
export function safeMeshEntries(list:string){
 const entries=list.split("\n").map(s=>s.trim()).filter(Boolean);
 return entries.length>0&&entries.every(e=>(e==="mesh-key.json"||e==="polyMesh/"||/^polyMesh\/[A-Za-z0-9_.]+(\/?|\/[A-Za-z0-9_.]+)$/.test(e))&&!e.includes(".."))&&entries.includes("mesh-key.json");
}
export async function runDomain3d(sim:SimulationJob,dir:string,container:Container,residuals:Residuals){
 const c=Domain3DCase.parse(sim.config);
 let processes=1;
 if(sim.stage==="solve"){
  const archive=join(dir,"mesh-input.tar.gz"),{stdout}=await exec("tar",["-tzf",archive],{timeout:30000,maxBuffer:4*1024*1024});
  if(!safeMeshEntries(stdout))throw new Error("Mesh snapshot has unexpected contents");
  const saved=JSON.parse((await exec("tar",["-xzOf",archive,"mesh-key.json"],{timeout:30000})).stdout);
  if(saved.version!==1||canonicalMeshKey(saved.key)!==meshKey(c)||!Number.isInteger(saved.cells)||saved.cells<1||saved.cells>DOMAIN3D_MAX_CELLS)throw new Error("Mesh snapshot does not match the case");
  processes=domain3dProcesses(saved.cells);
 }
 for(const [path,text] of Object.entries(domain3dFiles(c,processes))){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),text);}
 if(sim.stage==="mesh")await writeModelSurfaces(c,dir);
 console.log(`BEAM_STAGE ${sim.stage==="mesh"?"meshing":"checking"}\nOpenFOAM image ${OPENFOAM_IMAGE} · 3D · ${processes} process${processes>1?"es":""}`);
 const commands=sim.stage==="mesh"?domain3dMeshCommands(c):["tar -xzf mesh-input.tar.gz -C constant polyMesh",...domain3dSolveCommands(processes,streamlineSeeds(c).length>0)];
 await container(commands.join("; "),{cpus:4,memory:"4g"});
 await exportDomain3d(sim,dir,processes,residuals);
}
/** Rows of an OpenFOAM function-object .dat file keyed by its last commented header, vectors flattened. */
export function readDat(text:string){
 let columns:string[]=[];const rows:Record<string,number>[]=[];
 for(const line of text.split("\n")){
  if(line.startsWith("#")){const names=line.slice(1).trim().split(/\s+/);if(names[0]==="Time")columns=names;continue;}
  const values=line.replace(/[()]/g," ").trim().split(/\s+/).filter(Boolean).map(Number);
  if(!columns.length||values.length!==columns.length||!values.every(Number.isFinite))continue;
  rows.push(Object.fromEntries(columns.map((c,i)=>[c,values[i]!])));
 }
 return rows;
}
/** Second-half means of the body forces and, for flow along +x, Cd and Cl with a bounded history. */
export async function readForces(dir:string,c:Domain3DCase):Promise<Domain3DForces|undefined>{
 if(!c.bodies.length)return undefined;
 const forces=readDat(await readFile(join(dir,"postProcessing","forces","0","force.dat"),"utf8").catch(()=>""));
 if(!forces.length||!("total_x" in forces[0]!))return undefined;
 const from=c.duration/2,late=forces.filter(r=>r["Time"]!>=from),mean=(rows:Record<string,number>[],k:string)=>rows.reduce((s,r)=>s+r[k]!,0)/rows.length;
 if(!late.length)return undefined;
 const reference=forceReference(c),coeffs=flowAlongX(c)?readDat(await readFile(join(dir,"postProcessing","forceCoeffs","0","coefficient.dat"),"utf8").catch(()=>"")):[];
 const lateCoeffs=coeffs.filter(r=>r["Time"]!>=from&&"Cd" in r&&"Cl" in r),stride=Math.max(1,Math.ceil(coeffs.length/400));
 return Domain3DForces.parse({patches:[...new Set(c.bodies.map(b=>b.boundary))],speed:inletSpeed(c),referenceArea:reference.area,referenceLength:reference.length,averagedFrom:from,
  forceN:[mean(late,"total_x"),mean(late,"total_y"),mean(late,"total_z")],
  cd:lateCoeffs.length?mean(lateCoeffs,"Cd"):null,cl:lateCoeffs.length?mean(lateCoeffs,"Cl"):null,
  history:coeffs.filter((_,i)=>i%stride===0&&coeffs[i]!["Cd"]!==undefined).slice(0,400).map(r=>[r["Time"]!,r["Cd"]!,r["Cl"]!])});
}
/** Streamline tracks at the final time, thinned to a bounded number of points per line. */
export async function readStreamlines(dir:string,time:string):Promise<Domain3DStreamlines|undefined>{
 // The streamLine function object writes through the set writers, under postProcessing/sets.
 const folder=join(dir,"postProcessing","sets","streamLines",time),files=(await readdir(folder).catch(()=>[] as string[])).filter(f=>f.endsWith(".vtk")).sort();
 const lines:Domain3DStreamlines["lines"]=[];let lo=Infinity,hi=-Infinity;
 for(const file of files){
  const track=parseVtkSurface(await readFile(join(folder,file),"utf8")),U=track.fields["U"];
  if(!U||U.location!=="point"||U.components!==3)continue;
  let at=0;
  for(const n of track.counts){
   const ids=track.indices.slice(at,at+n);at+=n;if(n<2||lines.length>=160)continue;
   const stride=Math.max(1,Math.ceil(n/300)),kept=ids.filter((_,i)=>i%stride===0||i===n-1);
   const speed=kept.map(i=>Math.hypot(U.values[3*i]!,U.values[3*i+1]!,U.values[3*i+2]!));
   for(const v of speed){lo=Math.min(lo,v);hi=Math.max(hi,v);}
   lines.push({points:kept.flatMap(i=>[track.points[3*i]!,track.points[3*i+1]!,track.points[3*i+2]!]),speed});
  }
 }
 return lines.length?Domain3DStreamlines.parse({time:Number(time),lines,range:[lo,hi]}):undefined;
}
async function readSurfaces(dir:string,sub:string,order:ReturnType<typeof surfaceOrder>){
 return Promise.all(order.map(async s=>({...s,...parseVtkSurface(await readFile(join(dir,"postProcessing",...sub.split("/"),`${s.file}.vtk`),"utf8"))})));
}
export async function exportDomain3d(raw:unknown,dir:string,processes:number,residuals:Residuals){
 const sim=SimulationJob.parse(raw),c=Domain3DCase.parse(sim.config);
 const check=await readFile(join(dir,"check.log"),"utf8"),stats=meshStats(check);
 if(!check.includes("Mesh OK")||/Failed \d+ mesh checks/.test(check))throw new Error("Cannot export a mesh that failed quality checks");
 if(!Number.isInteger(stats.cells)||stats.cells<1||stats.cells>DOMAIN3D_MAX_CELLS)throw new Error(`Generated mesh has ${stats.cells} cells; the local 3D limit is ${DOMAIN3D_MAX_CELLS}. Lower refinement levels or increase meshSize`);
 const estimate=estimateDomain3dCells(c),order=surfaceOrder(c);
 const summary={backgroundCells:estimate.background,estimatedCells:estimate.estimated,cellTypes:stats.cellTypes,geometryChecks:"not evaluated",turbulence:c.turbulence.model==="kOmegaSST"?`RANS k-omega SST · I ${c.turbulence.intensity} · L ${c.turbulence.lengthScale} m · wall functions`:"laminar",processes,requestedFrames:c.frames,savedFrames:0,archive:"none" as "final-fields"|"dictionaries-only"|"none",maxNutRatio:null as number|null,forces:undefined as Domain3DForces|undefined};
 const solve=sim.stage==="solve"?await readFile(join(dir,"solve.log"),"utf8"):"",rows=residuals(solve,true);
 const report:SimulationReport={version:1,stage:sim.stage,config:c,image:OPENFOAM_IMAGE,cells:stats.cells,meshOk:true,maxNonOrthogonality:stats.maxNonOrthogonality,maxSkewness:stats.maxSkewness,iterations:rows.at(-1)?.iteration??0,converged:false,residuals:rows.filter((_,i)=>i%Math.max(1,Math.ceil(rows.length/25000))===0),massImbalance:null,pressureDropPa:null,outletTemperatureK:null,thermalBalance:"not-evaluated",meshSensitivity:"not-studied",domain3d:summary};
 if(sim.stage==="mesh"){
  summary.geometryChecks=geometryChecks(await readFile(join(dir,"check-all.log"),"utf8").catch(()=>""));
  await writeFile(join(dir,"constant","mesh-key.json"),JSON.stringify({version:1,key:meshKey(c),cells:stats.cells}));
  await exec("tar",["-czf",join(dir,"mesh.tar.gz"),"polyMesh","mesh-key.json"],{cwd:join(dir,"constant"),timeout:60000});
  if((await stat(join(dir,"mesh.tar.gz"))).size>MAX_COMPUTE_FILE_BYTES)throw new Error("Mesh snapshot exceeds 20 MB; lower refinement levels or increase meshSize");
  let surfaces=(await readSurfaces(dir,"meshView/0",order)).map(s=>({name:s.name,kind:s.kind,points:s.points,counts:s.counts,indices:s.indices}));
  let view=JSON.stringify(Domain3DMeshView.parse({version:1,kind:"domain3d-mesh",surfaces}));
  // Keep the pane's bounded preview readable; wall surfaces take priority over dense slices.
  if(view.length>7.5e6){surfaces=surfaces.filter(s=>s.kind==="wall");view=JSON.stringify(Domain3DMeshView.parse({version:1,kind:"domain3d-mesh",surfaces}));}
  await writeFile(join(dir,"mesh-view.json"),view);
 }else{
  if(!/^End\s*$/m.test(solve)||/FOAM FATAL/.test(solve))throw new Error("Cannot export an incomplete or failed solver log");
  const names=(await readdir(join(dir,"postProcessing","sampled"))).filter(p=>/^\d+(\.\d+)?(e[-+]?\d+)?$/.test(p)&&Number(p)>0).sort((a,b)=>Number(a)-Number(b));
  const finals=(await readdir(dir)).filter(p=>/^\d+(\.\d+)?(e[-+]?\d+)?$/.test(p)&&Number(p)>0).sort((a,b)=>Number(a)-Number(b)),final=finals.at(-1);
  if(!names.length||!final)throw new Error("Solver produced no sampled or final times");
  if(Math.abs(Number(final)-c.duration)>Math.max(1e-8,c.duration*1e-6))throw new Error("Solver did not reach the requested end time");
  const first=await readSurfaces(dir,`sampled/${names[0]}`,order),points=first.reduce((n,s)=>n+s.points.length/3,0);
  if(!points)throw new Error("Sampled surfaces are empty; check slice positions");
  const capacity=Math.floor(20e6/(points*16));if(capacity<1)throw new Error("Sampled surfaces exceed the playback budget; use fewer slices or coarser refinement");
  // Evenly subsample saved times when needed; the last computed time is always kept.
  const picked=names.length<=capacity?names:Array.from({length:capacity},(_,i)=>names[Math.round((names.length-1)*(i+1)/capacity)]!).filter((t,i,a)=>a.indexOf(t)===i);
  const buffer=Buffer.alloc(picked.length*points*16);let maxSpeed=0,minSpeed=Infinity,minP=Infinity,maxP=-Infinity,offset=0;
  for(const time of picked){
   const surfaces=time===names[0]?first:await readSurfaces(dir,`sampled/${time}`,order);
   surfaces.forEach((s,k)=>{
    const f=first[k]!,U=s.fields["U"],p=s.fields["p"],n=s.points.length/3;
    if(s.points.length!==f.points.length||s.indices.length!==f.indices.length||s.indices.some((v,i)=>v!==f.indices[i]))throw new Error(`Surface ${s.name} changed topology between saved times`);
    if(!U||!p||U.location!=="point"||p.location!=="point"||U.values.length!==n*3||p.values.length!==n)throw new Error(`Surface ${s.name} lacks interpolated U and p`);
    for(let i=0;i<n;i++){
     const ux=U.values[3*i]!,uy=U.values[3*i+1]!,uz=U.values[3*i+2]!,pa=p.values[i]!*c.region.density;
     if(s.kind==="slice"){const m=Math.hypot(ux,uy,uz);maxSpeed=Math.max(maxSpeed,m);minSpeed=Math.min(minSpeed,m);}
     minP=Math.min(minP,pa);maxP=Math.max(maxP,pa);
     for(const value of [ux,uy,uz,pa]){buffer.writeFloatLE(value,offset);offset+=4;}
    }
   });
  }
  const streamlines=await readStreamlines(dir,final);
  const manifest=Domain3DFields.parse({version:1,kind:"domain3d-surfaces",encoding:"float32-le",times:picked.map(Number),surfaces:first.map(s=>({name:s.name,kind:s.kind,points:s.points,triangles:triangulateFaces(s.counts,s.indices)})),ranges:{velocity:[Number.isFinite(minSpeed)?minSpeed:0,maxSpeed],pressure:[minP,maxP]},...(streamlines?{streamlines}:{})});
  // The pane reads fields.json within 8 MB; streamlines are the first thing to give up.
  let text=JSON.stringify(manifest);if(text.length>7.5e6&&streamlines){delete manifest.streamlines;text=JSON.stringify(manifest);}
  await writeFile(join(dir,"frames.bin"),buffer);await writeFile(join(dir,"fields.json"),text);
  const forces=await readForces(dir,c);if(forces)summary.forces=forces;
  summary.savedFrames=picked.length;report.physicalTime=Number(final);report.maxCourant=0;
  for(const m of solve.matchAll(/Courant Number mean: [\deE+.\-]+ max: ([\deE+.\-]+)/g))report.maxCourant=Math.max(report.maxCourant,Number(m[1]));
  if(c.turbulence.model==="kOmegaSST"){const minMax=await readFile(join(dir,"postProcessing","minMax","0","fieldMinMax.dat"),"utf8").catch(()=>"");const nut=minMax.split("\n").map(l=>l.match(/^\S+\s+nut\s+\S+\s+\([^)]*\)\s+(?:\d+\s+)?(\S+)\s+\(/)).filter(Boolean).at(-1);const max=nut?Number(nut[1]):NaN;summary.maxNutRatio=Number.isFinite(max)?max/c.region.nu:null;}
  await writeFile(join(dir,"case.foam"),"");
  const logs=["check.log","solve.log",...(processes>1?["decompose.log","reconstruct.log"]:[])];
  await exec("tar",["-czf","case.tar.gz","0","constant","system",final,"case.foam",...logs],{cwd:dir,timeout:120000});summary.archive="final-fields";
  if((await stat(join(dir,"case.tar.gz"))).size>MAX_COMPUTE_FILE_BYTES){
   await exec("tar",["-czf","case.tar.gz","0","system","constant/transportProperties","constant/turbulenceProperties","case.foam",...logs],{cwd:dir,timeout:60000});summary.archive="dictionaries-only";
  }
 }
 await writeFile(join(dir,"report.json"),JSON.stringify(SimulationReport.parse(report)));
 console.log(`BEAM_STAGE complete\n${stats.cells} cells · ${report.iterations} time steps · ${summary.turbulence}`);
}
