import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { OPENFOAM_IMAGE, defaultChannel, defaultCylinder, WakeFields, decodeWakeFrames, SimulationReport, SimulationFields, simulationOutputs, type ProcessJobSpec } from "@beam/contracts";
import { foamValues, residualHistory } from "./openfoam.ts";
import { LocalExecutor } from "./local.ts";

it("reads uniform and nonuniform scalar/vector fields and rejects incomplete exports",()=>{
  expect(foamValues("internalField uniform (1 0 0);",2,3)).toEqual([1,0,0,1,0,0]);
  expect(foamValues("internalField nonuniform List<scalar> 3 (1 -2 3e-4);",3)).toEqual([1,-2,.0003]);
  expect(foamValues("internalField nonuniform List<vector> 2 ((1 0 0) (0 2 0));",2,3)).toEqual([1,0,0,0,2,0]);
  expect(()=>foamValues("internalField nonuniform List<scalar> 4 (1 2 3);",4)).toThrow();
  expect(()=>foamValues("internalField nonuniform List<scalar> 2 (1 2);",3)).toThrow();
  expect(()=>foamValues("internalField uniform nan;",3)).toThrow();
});
it("retains initial and final residuals with their solver iteration",()=>{
  expect(residualHistory("Time = 12\nDICPCG: Solving for p_rgh, Initial residual = 1.2e-4, Final residual = 2e-9, No Iterations 4")).toEqual([{iteration:12,field:"p_rgh",initial:1.2e-4,final:2e-9}]);
});

// Explicit opt-in: requires Docker and the pinned image; never pulls or installs during tests.
describe.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1")("real OpenFOAM through the durable supervisor",()=>{
  it("cancels a running Docker job without leaving its container alive",async()=>{
    const root=await mkdtemp(join(tmpdir(),"beam-foam-cancel-"));
    const name="beam-foam-"+createHash("sha256").update(root).digest("hex").slice(0,20);
    const exec=promisify(execFile);
    await mkdir(join(root,"work"));
    await writeFile(join(root,"spec.json"),JSON.stringify({executable:"docker",args:["run","--rm","--name",name,"--network","none","--entrypoint","sleep",OPENFOAM_IMAGE,"30"],timeoutSeconds:60,dockerContainer:name}));
    const worker=spawn(process.execPath,[fileURLToPath(new URL("./worker.mjs",import.meta.url)),root],{stdio:"ignore"});
    const done=new Promise(resolve=>worker.once("exit",resolve));
    try{
      let started=false;
      for(let i=0;i<100;i++){try{const {stdout}=await exec("docker",["inspect","-f","{{.State.Running}}",name]);if(stdout.trim()==="true"){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
      expect(started).toBe(true);await writeFile(join(root,"cancel"),"cancel");await done;
      expect(JSON.parse(await readFile(join(root,"result.json"),"utf8")).state).toBe("cancelled");
      await expect(exec("docker",["inspect",name])).rejects.toThrow();
    }finally{worker.kill("SIGKILL");await exec("docker",["rm","-f",name]).catch(()=>{});await rm(root,{recursive:true,force:true});}
  },30000);

  it("builds a checked mesh, solves its immutable snapshot and exports physical fields",async()=>{
    const root=await mkdtemp(join(tmpdir(),"beam-foam-test-")),executor=new LocalExecutor(root);
    const spec=(stage:"mesh"|"solve"):ProcessJobSpec=>({version:1,kind:"process",title:"Channel integration",executable:"beam:openfoam",args:[],inputs:stage==="mesh"?[]:[{assetId:"mesh",path:"mesh-input.json"}],outputs:simulationOutputs(stage),timeoutSeconds:60,simulation:{image:OPENFOAM_IMAGE,caseId:"integration",revision:1,stage,config:defaultChannel,...(stage==="solve"?{meshJobId:"mesh"}:{})}});
    async function finish(id:string){const until=Date.now()+55000;while(Date.now()<until){const s=await executor.inspect({backend:executor.backend,id});if(s.state!=="running"){expect(s.error,s.log).toBe(null);expect(s.state,s.log).toBe("succeeded");return;}await new Promise(r=>setTimeout(r,100));}throw new Error("Integration timed out");}
    try{
      await executor.submit("mesh",spec("mesh"),[]);await finish("mesh");
      const report=SimulationReport.parse(JSON.parse(await readFile(join(root,"mesh/work/report.json"),"utf8")));expect(report.meshOk).toBe(true);expect(report.cells).toBe(1200);
      const bytes=await readFile(join(root,"mesh/work/mesh.json"));
      await executor.submit("solve",spec("solve"),[{path:"mesh-input.json",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),url:`data:application/json;base64,${bytes.toString("base64")}`}]);await finish("solve");
      const solved=SimulationReport.parse(JSON.parse(await readFile(join(root,"solve/work/report.json"),"utf8"))),f=SimulationFields.parse(JSON.parse(await readFile(join(root,"solve/work/fields.json"),"utf8")));
      expect(solved.converged).toBe(true);expect(solved.pressureDropPa).toBeGreaterThan(0);expect(f.centres).toHaveLength(1200);
      expect(Math.min(...f.temperature)).toBeGreaterThanOrEqual(defaultChannel.inletTemperature-1e-5);expect(Math.max(...f.temperature)).toBeLessThanOrEqual(defaultChannel.wallTemperature+1e-5);
      // Developed laminar planar-channel centreline velocity tends to 1.5 times bulk velocity.
      const outlet=f.centres.flatMap((p,i)=>p[0]>.19?[f.velocity[i]!]:[]);expect(Math.max(...outlet)/defaultChannel.velocity).toBeCloseTo(1.5,1);
      expect((await executor.readOutput({backend:executor.backend,id:"solve"},"case.tar.gz")).length).toBeGreaterThan(1000);
    }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
  },120000);
});

it("counts transient steps rather than rounding physical times",()=>{
 const text="Time = 0.001\nSolving for p, Initial residual = 0.1, Final residual = 1e-7\nTime = 2e-3\nSolving for p, Initial residual = 0.01, Final residual = 1e-8";
 expect(residualHistory(text,true).map(r=>r.iteration)).toEqual([1,2]);
});
it.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1")("exports a real transient cylinder wake with alternating cross-flow",async()=>{
 const root=await mkdtemp(join(tmpdir(),"beam-wake-test-")),executor=new LocalExecutor(root);
 const spec=(stage:"mesh"|"solve"):ProcessJobSpec=>({version:1,kind:"process",title:"Cylinder integration",executable:"beam:openfoam",args:[],inputs:stage==="mesh"?[]:[{assetId:"mesh",path:"mesh-input.json"}],outputs:simulationOutputs(stage,defaultCylinder),timeoutSeconds:300,simulation:{image:OPENFOAM_IMAGE,caseId:"wake",revision:1,stage,config:defaultCylinder,...(stage==="solve"?{meshJobId:"mesh"}:{})}});
 async function finish(id:string){const until=Date.now()+290000;while(Date.now()<until){const s=await executor.inspect({backend:executor.backend,id});if(s.state!=="running"){expect(s.error,s.log).toBe(null);expect(s.state,s.log).toBe("succeeded");return;}await new Promise(r=>setTimeout(r,500));}throw new Error("Wake timed out");}
 try{
  await executor.submit("mesh",spec("mesh"),[]);await finish("mesh");const bytes=await readFile(join(root,"mesh/work/mesh.json"));
  await executor.submit("solve",spec("solve"),[{path:"mesh-input.json",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),url:`data:application/json;base64,${bytes.toString("base64")}`}]);await finish("solve");
  const report=SimulationReport.parse(JSON.parse(await readFile(join(root,"solve/work/report.json"),"utf8")));
  const fields=WakeFields.parse(JSON.parse(await readFile(join(root,"solve/work/fields.json"),"utf8")));
  const binary=await executor.readOutput({backend:executor.backend,id:"solve"},"frames.bin");const frames=decodeWakeFrames(Uint8Array.from(binary).buffer,fields);
  expect(report.meshOk).toBe(true);expect(report.physicalTime).toBeCloseTo(10);expect(report.maxCourant).toBeLessThan(1);expect(fields.times).toHaveLength(100);
  const n=fields.centres.length,cell=fields.centres.reduce((best,p,i)=>(p[0]-.04)**2+p[1]**2<(fields.centres[best]![0]-.04)**2+fields.centres[best]![1]**2?i:best,0);
  const transverse=fields.times.slice(40).map((_,i)=>frames[((i+40)*n+cell)*4+1]!);
  expect(Math.min(...transverse)).toBeLessThan(-.01);expect(Math.max(...transverse)).toBeGreaterThan(.01);
 }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
},330000);

it("exports 100 snapshots after a long solve without spreading residuals or Courant samples onto the stack",async()=>{
 const {exportOpenFoam}=await import("./openfoam.ts");
 const {planarMesh,planarFiles}=await import("./planar.ts");
 const {defaultPlanar}=await import("@beam/contracts");
 const config={...defaultPlanar,bodies:[],boundaries:defaultPlanar.boundaries.slice(0,3),meshSize:.01,duration:10,frames:100};
 const root=await mkdtemp(join(tmpdir(),"beam-large-export-"));
 try{
  const mesh=planarMesh(config),files={...mesh.files,...planarFiles(config)};
  for(const [p,text] of Object.entries(files)){await mkdir(join(root,p,".."),{recursive:true});await writeFile(join(root,p),text);}
  await writeFile(join(root,"check.log"),`cells: ${mesh.cells}\nMesh OK\n`);
  const rows=Array.from({length:10000},(_,i)=>`Time = ${(i+1)/1000}\n`+"Courant Number mean: 0.1 max: 0.75\nGAMG: Solving for p, Initial residual = 1e-4, Final residual = 1e-8\n".repeat(16)).join("");
  await writeFile(join(root,"solve.log"),rows+"End\n");
  for(let i=1;i<=100;i++){const dir=join(root,String(i/10));await mkdir(dir);for(const [f,v] of Object.entries({U:"(.1 0 0)",p:".002",vorticity:"(0 0 3)"}))await writeFile(join(dir,f),`internalField uniform ${v};`);}
  await writeFile(join(root,"10/C"),`internalField nonuniform List<vector> ${mesh.cells} (${mesh.polygons.map(p=>`(${p.reduce((s,v)=>s+v[0],0)/3} ${p.reduce((s,v)=>s+v[1],0)/3} 0)`).join(" ")});`);
  const sim={caseId:"test",revision:1,stage:"solve",meshJobId:"mesh",config};
  await exportOpenFoam(sim,root);
  const report=SimulationReport.parse(JSON.parse(await readFile(join(root,"report.json"),"utf8"))),fields=WakeFields.parse(JSON.parse(await readFile(join(root,"fields.json"),"utf8")));
  expect(report.iterations).toBe(10000);expect(report.residuals.length).toBeLessThanOrEqual(25000);expect(report.physicalTime).toBe(10);expect(report.maxCourant).toBe(.75);expect(fields.times).toHaveLength(100);
  const frames=decodeWakeFrames(Uint8Array.from(await readFile(join(root,"frames.bin"))).buffer,fields);expect(frames.at(-1)).toBe(3);expect(frames[2]).toBeCloseTo(2);
  await writeFile(join(root,"solve.log"),"Time = 10\nFOAM FATAL ERROR\n");await expect(exportOpenFoam(sim,root)).rejects.toThrow("incomplete or failed");
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
