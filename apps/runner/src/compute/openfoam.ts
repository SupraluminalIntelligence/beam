import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelCase, SimulationJob, SimulationReport, SimulationFields, WakeFields, OPENFOAM_IMAGE, meshKey, canonicalMeshKey, type ProcessJobSpec } from "@beam/contracts";
import { cylinderFiles, meshPolygons } from "./cylinder.ts";
import { exportMovingMesh } from "./movingMesh.ts";
import { planarFiles, planarMesh } from "./planar.ts";
const exec = promisify(execFile);
export async function probeOpenFoam(){
  try{await exec("docker",["info","--format","{{.OSType}}"],{timeout:6000});await exec("docker",["image","inspect",OPENFOAM_IMAGE],{timeout:6000,maxBuffer:1024*1024});return{ready:true,message:"OpenFOAM 2512 · local Docker",image:OPENFOAM_IMAGE};}
  catch{return{ready:false,message:`Start Docker and install the OpenFOAM runtime: docker pull ${OPENFOAM_IMAGE}`,image:OPENFOAM_IMAGE};}
}
const containerName=(root:string)=>"beam-foam-"+createHash("sha256").update(root).digest("hex").slice(0,20);
export async function stopFoamContainer(root:string){await exec("docker",["rm","-f",containerName(root)],{timeout:10000});}
export function foamProcess(spec:ProcessJobSpec,root:string){
  const name=containerName(root);
  const cli=fileURLToPath(import.meta.url.endsWith(".mjs")?new URL(import.meta.url):new URL("../cli.ts",import.meta.url));
  return {...spec,executable:process.execPath,args:[...(cli.endsWith(".ts")?["--experimental-strip-types"]:[]),cli,"openfoam-job",JSON.stringify(spec.simulation),name],dockerContainer:name};
}
const header=(object:string,klass="dictionary")=>`FoamFile { version 2.0; format ascii; class ${klass}; object ${object}; }\n`;
export function channelFiles(raw:ChannelCase):Record<string,string>{
  const c=ChannelCase.parse(raw),L=c.length,H=c.height,Z=0.001;
  const field=(name:string,dim:string,initial:string,bc:string,vector=false)=>header(name,vector?"volVectorField":"volScalarField")+`dimensions ${dim};\ninternalField uniform ${initial};\nboundaryField { ${bc} frontAndBack { type empty; } }\n`;
  return {
    "system/blockMeshDict":header("blockMeshDict")+`scale 1; vertices ((0 0 0) (${L} 0 0) (${L} ${H} 0) (0 ${H} 0) (0 0 ${Z}) (${L} 0 ${Z}) (${L} ${H} ${Z}) (0 ${H} ${Z})); blocks (hex (0 1 2 3 4 5 6 7) (${c.nx} ${c.ny} 1) simpleGrading (1 1 1)); edges (); boundary (inlet {type patch; faces ((0 4 7 3));} outlet {type patch; faces ((1 2 6 5));} walls {type wall; faces ((0 1 5 4) (3 7 6 2));} frontAndBack {type empty; faces ((0 3 2 1) (4 5 6 7));}); mergePatchPairs ();`,
    "system/controlDict":header("controlDict")+`application buoyantBoussinesqSimpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime ${c.iterations}; deltaT 1; writeControl timeStep; writeInterval 50; purgeWrite 1; writeFormat ascii; writePrecision 12; writeCompression off; timeFormat general; timePrecision 8; runTimeModifiable false;`,
    "system/fvSchemes":header("fvSchemes")+`ddtSchemes {default steadyState;} gradSchemes {default Gauss linear;} divSchemes {default none; div(phi,U) bounded Gauss linearUpwind grad(U); div(phi,T) bounded Gauss upwind; div((nuEff*dev2(T(grad(U))))) Gauss linear;} laplacianSchemes {default Gauss linear corrected;} interpolationSchemes {default linear;} snGradSchemes {default corrected;} fluxRequired {default no; p_rgh;}`, 
    "system/fvSolution":header("fvSolution")+`solvers {p_rgh {solver PCG; preconditioner DIC; tolerance 1e-9; relTol 0.01;} "(U|T)" {solver PBiCGStab; preconditioner DILU; tolerance 1e-9; relTol 0.05;}} SIMPLE {nNonOrthogonalCorrectors 0; pRefCell 0; pRefValue 0; residualControl {p_rgh 1e-6; U 1e-7; T 1e-7;}} relaxationFactors {fields {p_rgh 0.3;} equations {U 0.7; T 0.7;}}`,
    "constant/transportProperties":header("transportProperties")+`transportModel Newtonian; nu ${c.nu}; beta 0; TRef ${c.inletTemperature}; Pr ${c.pr}; Prt 0.85;`,
    "constant/turbulenceProperties":header("turbulenceProperties")+"simulationType laminar;",
    "constant/g":header("g","uniformDimensionedVectorField")+"dimensions [0 1 -2 0 0 0 0]; value (0 0 0);",
    "0/U":field("U","[0 1 -1 0 0 0 0]",`(${c.velocity} 0 0)`,`inlet {type fixedValue; value uniform (${c.velocity} 0 0);} outlet {type zeroGradient;} walls {type noSlip;}`,true),
    "0/p_rgh":field("p_rgh","[0 2 -2 0 0 0 0]","0","inlet {type zeroGradient;} outlet {type fixedValue; value uniform 0;} walls {type zeroGradient;}"),
    "0/p":field("p","[0 2 -2 0 0 0 0]","0","inlet {type calculated; value uniform 0;} outlet {type calculated; value uniform 0;} walls {type calculated; value uniform 0;}"),
    "0/T":field("T","[0 0 0 1 0 0 0]",String(c.inletTemperature),`inlet {type fixedValue; value uniform ${c.inletTemperature};} outlet {type zeroGradient;} walls {type ${c.thermal?`fixedValue; value uniform ${c.wallTemperature}`:"zeroGradient"};}`),
    "0/alphat":field("alphat","[0 2 -1 0 0 0 0]","0","inlet {type calculated; value uniform 0;} outlet {type calculated; value uniform 0;} walls {type fixedValue; value uniform 0;}"),
  };
}
/** Only ASCII internal fields from our pinned runtime; reject incomplete/non-finite arrays. */
export function foamValues(text:string,expected:number,components=1):number[]{
  const clean=text.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
  const non=clean.match(/internalField\s+nonuniform\s+List<\w+>\s+(\d+)\s*\(([\s\S]*?)\)\s*;/);
  let values:number[];
  if(non){if(Number(non[1])!==expected)throw new Error("OpenFOAM field count differs from mesh");values=(non[2]!.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)??[]).map(Number);}
  else{const uniform=clean.match(/internalField\s+uniform\s+([^;]+);/);if(!uniform)throw new Error("Missing ASCII internalField");const v=(uniform[1]!.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)??[]).map(Number);if(v.length!==components)throw new Error("Invalid uniform field");values=Array.from({length:expected},()=>v).flat();}
  if(values.length!==expected*components||!values.every(Number.isFinite))throw new Error("Invalid OpenFOAM values");return values;
}
export function residualHistory(log:string,transient=false){let iteration=0;const rows:{iteration:number;field:string;initial:number;final:number}[]=[];for(const line of log.split("\n")){const t=line.match(/^Time = ([\deE+.\-]+)/);if(t)iteration=transient?iteration+1:Number(t[1]);const r=line.match(/Solving for (\w+), Initial residual = ([\deE+.\-]+), Final residual = ([\deE+.\-]+)/);if(r)rows.push({iteration,field:r[1]!,initial:Number(r[2]),final:Number(r[3])});}return rows.filter(r=>Number.isFinite(r.initial)&&Number.isFinite(r.final));}
const metric = (text:string, re:RegExp) => { const found=text.match(re); return found ? Number(found[1]) : null; };
export async function runOpenFoam(raw:unknown,name:string){
  const sim=SimulationJob.parse(raw),c=sim.config,dir=process.cwd();
  if(!/^beam-foam-[a-f0-9]{20}$/.test(name))throw new Error("Invalid container handle");
  const ready=await probeOpenFoam();if(!ready.ready)throw new Error(ready.message);
  for(const [path,text] of Object.entries(c.geometry==="channel"?channelFiles(c):c.geometry==="planar"?planarFiles(c):cylinderFiles(c))){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),text);}
  if(c.geometry==="planar"&&sim.stage==="mesh"){const generated=planarMesh(c);await writeFile(join(dir,"mesh-view.json"),JSON.stringify({version:1,polygons:generated.polygons}));for(const [path,text] of Object.entries(generated.files)){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),text);}}
  const meshNames=foamMeshNames;
  if(sim.stage==="solve"){
    const saved=JSON.parse(await readFile(join(dir,"mesh-input.json"),"utf8"));
    if(saved.version!==1||canonicalMeshKey(saved.key)!==meshKey(c)||!saved.files||Object.keys(saved.files).sort().join()!==meshNames.slice().sort().join())throw new Error("Mesh snapshot does not match the case");
    await mkdir(join(dir,"constant/polyMesh"),{recursive:true});for(const file of meshNames){if(typeof saved.files[file]!=="string"||saved.files[file].length>20e6)throw new Error("Invalid mesh snapshot");await writeFile(join(dir,"constant/polyMesh",file),saved.files[file]);}
  }
  console.log(`BEAM_STAGE ${sim.stage==="mesh"?"meshing":"checking"}\nOpenFOAM image ${OPENFOAM_IMAGE}`);
  const commands=[sim.stage==="mesh"&&c.geometry!=="planar"?"blockMesh > mesh.log 2>&1":"true","checkMesh -allTopology -allGeometry > check.log 2>&1","cat check.log","grep -q 'Mesh OK' check.log",...(sim.stage==="solve"?["echo BEAM_STAGE solving",`${c.geometry==="channel"?"buoyantBoussinesqSimpleFoam":"pimpleFoam"} > solve.log 2>&1`,"cat solve.log","echo BEAM_STAGE exporting","postProcess -func writeCellCentres -latestTime > centres.log 2>&1",...(c.geometry==="planar"&&c.motion?["checkMesh -allTopology -allGeometry -time '0:' > motion-check.log 2>&1"]:[])]:[])];
  const script="source /usr/lib/openfoam/openfoam2512/etc/bashrc; cd /case; set -e; "+commands.join("; ");
  // No network, credentials or host mounts beyond this job directory. Images are installed explicitly.
  const child=spawn("docker",["run","--rm","--pull=never","--name",name,"--network","none","--cpus","2","--memory","2g","--pids-limit","256","-v",`${dir}:/case`,"-w","/case","--entrypoint","/bin/bash",OPENFOAM_IMAGE,"-lc",script],{stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",d=>process.stdout.write(d));child.stderr.on("data",d=>process.stderr.write(d));
  // Tail the solver log while it runs; the durable supervisor keeps the bounded live log.
  let offset=0,reading=false;const timer=setInterval(async()=>{if(reading)return;reading=true;try{const s=await readFile(join(dir,"solve.log"),"utf8");if(s.length>offset){process.stdout.write(s.slice(offset));offset=s.length;}}catch{}finally{reading=false;}},1000);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);}).finally(()=>clearInterval(timer));
  if(code!==0){for(const path of ["mesh.log","check.log","solve.log","centres.log","motion-check.log"]){try{console.error((await readFile(join(dir,path),"utf8")).slice(-4000));}catch{}}throw new Error(`OpenFOAM exited with code ${code}`);}
  await exportOpenFoam(sim,dir);
}
const foamMeshNames=["points","faces","owner","neighbour","boundary"];
/** Export existing solver files without launching or modifying the calculation. */
export async function exportOpenFoam(raw:unknown,dir:string){
  const sim=SimulationJob.parse(raw),c=sim.config,meshNames=foamMeshNames;
  const check=await readFile(join(dir,"check.log"),"utf8"),cells=Number(check.match(/cells:\s+(\d+)/)?.[1]);
  if(!Number.isInteger(cells)||cells<1||cells>12800)throw new Error("Mesh exceeds cell budget");
  if(c.geometry!=="planar"&&cells!==(c.geometry==="channel"?c.nx*c.ny:c.version===1?5568:7344))throw new Error("Generated mesh cell count does not match the case");
  const solve=sim.stage==="solve"?await readFile(join(dir,"solve.log"),"utf8"):"",residuals=residualHistory(solve,c.geometry!=="channel");
  if(!check.includes("Mesh OK")||/Failed \d+ mesh checks/.test(check))throw new Error("Cannot export a mesh that failed quality checks");
  if(sim.stage==="solve"&&(!/^End\s*$/m.test(solve)||/FOAM FATAL/.test(solve)))throw new Error("Cannot export an incomplete or failed solver log");
  const report:SimulationReport={version:1,stage:sim.stage,config:c,image:OPENFOAM_IMAGE,cells,meshOk:check.includes("Mesh OK"),maxNonOrthogonality:metric(check, /non-orthogonality Max:\s*([\d.eE+-]+)/i),maxSkewness:metric(check, /Max skewness\s*=\s*([\d.eE+-]+)/i),iterations:residuals.reduce((max,r)=>Math.max(max,r.iteration),0),converged:/SIMPLE solution converged/.test(solve),residuals:residuals.filter((_,i)=>i%Math.max(1,Math.ceil(residuals.length/25000))===0),massImbalance:null,pressureDropPa:null,outletTemperatureK:null,thermalBalance:"not-evaluated",meshSensitivity:"not-studied"};
  if(sim.stage==="mesh"){
    const files:Record<string,string>={};for(const file of meshNames)files[file]=await readFile(join(dir,"constant/polyMesh",file),"utf8");await writeFile(join(dir,"mesh.json"),JSON.stringify({version:1,key:meshKey(c),files}));
  }else{
    const times=(await readdir(dir)).filter(p=>/^\d+(\.\d+)?$/.test(p)).map(Number).filter(n=>n>0).sort((a,b)=>a-b),time=times.at(-1);if(time===undefined)throw new Error("Solver produced no time directory");
    const field=async(n:string,components=1)=>foamValues(await readFile(join(dir,String(time),n),"utf8"),cells,components);
    if(c.geometry==="channel"){
    const [C,U,P,T]=await Promise.all([field("C",3),field("U",3),field("p"),field("T")]);
    const centres=Array.from({length:cells},(_,i)=>[C[3*i]!,C[3*i+1]!,C[3*i+2]!] as [number,number,number]);
    const fields=SimulationFields.parse({version:1,centres,velocity:centres.map((_,i)=>Math.hypot(U[3*i]!,U[3*i+1]!,U[3*i+2]!)),pressure:P.map(p=>p*c.density),temperature:T});
    // Cell-adjacent estimates are labeled as such in the UI; not surface-integral conservation checks.
    const left=centres.map((p,i)=>p[0]<c.length/c.nx?i:-1).filter(i=>i>=0),right=centres.map((p,i)=>p[0]>c.length-c.length/c.nx?i:-1).filter(i=>i>=0);
    const mean=(a:number[],idx:number[])=>idx.reduce((s,i)=>s+a[i]!,0)/idx.length;
    report.pressureDropPa=mean(fields.pressure,left)-mean(fields.pressure,right);report.outletTemperatureK=mean(T,right);
    await writeFile(join(dir,"fields.json"),JSON.stringify(fields));
    }else{
      const C=await field("C",3);
      let centres=Array.from({length:cells},(_,i)=>[C[3*i]!,C[3*i+1]!] as [number,number]);
      const texts=await Promise.all(["points","faces","owner"].map(n=>readFile(join(dir,"constant/polyMesh",n),"utf8")));
      const polygons=meshPolygons(texts[0]!,texts[1]!,texts[2]!,cells);
      let motion:WakeFields["motion"];
      if(c.geometry==="planar"&&c.motion){
        const checks=await readFile(join(dir,"motion-check.log"),"utf8");
        if(/Failed|FOAM FATAL/.test(checks)||(checks.match(/Mesh OK/g)??[]).length<times.length)throw new Error("Moving mesh failed saved-time quality checks");
        const moving=await exportMovingMesh(dir,times,polygons,texts[1]!,texts[2]!);motion=moving.manifest;
        centres=polygons.map(p=>[p.reduce((s,v)=>s+v[0],0)/3,p.reduce((s,v)=>s+v[1],0)/3]);
        report.motion={checkedFrames:moving.checkedFrames,minCellAreaM2:moving.minArea};
      }
      const buffer=Buffer.alloc(times.length*cells*16);
      if(buffer.length>20e6||times.length>120)throw new Error("Wake results exceed playback budget");
      let maxSpeed=0,minP=Infinity,maxP=-Infinity,maxOmega=0;
      for(let frame=0;frame<times.length;frame++){
        const values=async(n:string,components=1)=>foamValues(await readFile(join(dir,String(times[frame]),n),"utf8"),cells,components);
        const [U,P,W]=await Promise.all([values("U",3),values("p"),values("vorticity",3)]);
        for(let i=0;i<cells;i++){
          const p=P[i]!*(c.geometry==="planar"?c.region.density:c.density),w=W[i*3+2]!;
          maxSpeed=Math.max(maxSpeed,Math.hypot(U[i*3]!,U[i*3+1]!));minP=Math.min(minP,p);maxP=Math.max(maxP,p);maxOmega=Math.max(maxOmega,Math.abs(w));
          [U[i*3]!,U[i*3+1]!,p,w].forEach((v,k)=>buffer.writeFloatLE(v,(frame*cells*4+i*4+k)*4));
        }
      }
      const manifest=WakeFields.parse({version:1,kind:c.geometry==="planar"?"planar-flow":"cylinder-wake",encoding:"float32-le",times,centres,polygons,...(motion?{motion}:{}),ranges:{velocity:[0,maxSpeed],pressure:[minP,maxP],vorticity:[-maxOmega,maxOmega]}});
      await writeFile(join(dir,"frames.bin"),buffer);await writeFile(join(dir,"fields.json"),JSON.stringify(manifest));
      const expected=c.geometry==="planar"?c.duration:c.duration*c.diameter/c.velocity;
      if(Math.abs(time-expected)>Math.max(1e-8,expected*1e-6))throw new Error("Solver did not reach the requested end time");
      report.physicalTime=time;report.iterations=residuals.at(-1)?.iteration??0;
      report.maxCourant=0;
      for(const m of solve.matchAll(/Courant Number mean: [\deE+.\-]+ max: ([\deE+.\-]+)/g))report.maxCourant=Math.max(report.maxCourant,Number(m[1]));
      report.converged=false; // A completed transient is not steady-state convergence.
    }
    await writeFile(join(dir,"case.foam"),"");await exec("tar",["-czf","case.tar.gz","0","constant","system",String(time),"case.foam","solve.log","check.log",...(c.geometry==="planar"&&c.motion?["motion-check.log"]:[])],{cwd:dir,timeout:30000});
  }
  await writeFile(join(dir,"report.json"),JSON.stringify(SimulationReport.parse(report)));
  console.log(`BEAM_STAGE complete\n${cells} cells · ${report.iterations} iterations · convergence ${report.converged?"met":"not evaluated or not met"}`);
}
