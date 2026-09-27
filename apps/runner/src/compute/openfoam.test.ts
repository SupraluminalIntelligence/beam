import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { OPENFOAM_IMAGE, defaultChannel, defaultCylinder, defaultParallelChannels, parallelSetupChecks, WakeFields, decodeWakeFrames, SimulationReport, SimulationFields, simulationOutputs, channelMeshStudy, fluxWallEstimate, type GridEstimate, type ProcessJobSpec } from "@beam/contracts";
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
      // Conservation from the solver's face fluxes, and the developed pressure gradient against f·Re = 96.
      const ch=solved.channel!;expect(Math.abs(solved.massImbalance!)).toBeLessThan(1e-6);expect(Math.abs(ch.energyImbalance!)).toBeLessThan(1e-4);
      expect(ch.fRe!).toBeGreaterThan(94);expect(ch.fRe!).toBeLessThan(98);
      // Flow weighting favours the cooler core, so the bulk outlet temperature sits below the column's arithmetic mean.
      expect(ch.bulkOutletTemperatureK).toBeGreaterThan(defaultChannel.inletTemperature);expect(ch.bulkOutletTemperatureK).toBeLessThan(solved.outletTemperatureK!);
      // Thermally developing over the whole channel: local Nu falls along x and stays above the developed 7.54.
      expect(ch.nusselt[0]![1]).toBeGreaterThan(ch.nusselt.at(-1)![1]);expect(ch.nusselt.at(-1)![1]).toBeGreaterThan(7.54);
    }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
  },120000);

  // HFE-7100 in a 1 mm gap at 20 cm/s: thermal entry ≈ 16.5 cm of 20 cm.
  const hfe={...defaultChannel,height:.001,velocity:.2,nu:3.8e-7,pr:9.8,density:1510,inletTemperature:293.15,wallTemperature:323.15};
  async function solveChannel(config:typeof hfe,caseId:string){
    const root=await mkdtemp(join(tmpdir(),"beam-foam-channel-")),executor=new LocalExecutor(root);
    const spec=(stage:"mesh"|"solve"):ProcessJobSpec=>({version:1,kind:"process",title:caseId,executable:"beam:openfoam",args:[],inputs:stage==="mesh"?[]:[{assetId:"mesh",path:"mesh-input.json"}],outputs:simulationOutputs(stage),timeoutSeconds:120,simulation:{image:OPENFOAM_IMAGE,caseId,revision:1,stage,config,...(stage==="solve"?{meshJobId:"mesh"}:{})}});
    async function finish(id:string){const until=Date.now()+110000;while(Date.now()<until){const s=await executor.inspect({backend:executor.backend,id});if(s.state!=="running"){expect(s.state,s.log).toBe("succeeded");return;}await new Promise(r=>setTimeout(r,100));}throw new Error("Integration timed out");}
    try{
      await executor.submit("mesh",spec("mesh"),[]);await finish("mesh");
      const bytes=await readFile(join(root,"mesh/work/mesh.json"));
      await executor.submit("solve",spec("solve"),[{path:"mesh-input.json",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),url:`data:application/json;base64,${bytes.toString("base64")}`}]);await finish("solve");
      return SimulationReport.parse(JSON.parse(await readFile(join(root,"solve/work/report.json"),"utf8")));
    }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
  }
  it("reaches the developed parallel-plate Nusselt number past the thermal entry length",async()=>{
    const ch=(await solveChannel({...hfe,nx:160,ny:20},"developed")).channel!;
    expect(ch.nusselt.at(-1)![1]/7.54).toBeGreaterThan(1);expect(ch.nusselt.at(-1)![1]/7.54).toBeLessThan(1.05);
    expect(Math.abs(ch.fRe!/96-1)).toBeLessThan(.02);expect(Math.abs(ch.energyImbalance!)).toBeLessThan(1e-4);
  },240000);

  it("estimates discretization error from three meshes refined by 1.5",async()=>{
    const reports=[];for(const [nx,ny] of [[60,8],[90,12],[135,18]] as const)reports.push(await solveChannel({...hfe,nx,ny,iterations:3000},`mesh-${nx}`));
    const study=channelMeshStudy(reports);if("problem" in study)throw new Error(study.problem);
    expect(study.estimates.map(e=>e.convergence)).toEqual(["monotonic","monotonic","monotonic"]);
    const [rise,fRe,nu]=study.estimates as [GridEstimate,GridEstimate,GridEstimate];
    // Temperature is advected with first-order upwind, so its observed order is near 1; the second-order velocity gives f·Re near 2.
    expect(rise.order!).toBeGreaterThan(.7);expect(rise.order!).toBeLessThan(1.3);expect(fRe.order!).toBeGreaterThan(1.5);
    expect(Math.abs(fRe.extrapolated!/96-1)).toBeLessThan(.01);expect(nu.extrapolated!/7.54).toBeGreaterThan(1);
    expect(Math.max(...study.estimates.map(e=>e.gci!))).toBeLessThan(.05);
  },360000);

  it("heats both walls with a uniform flux, conserves its energy and approaches Nu = 8.235",async()=>{
    // 0.5 W/cm² at 10 cm/s: thermal entry ≈ 11.9 cm of 20 cm. The bulk rise is fixed by the energy balance, 2q''L/(ρ·cp·U·H).
    const config={...hfe,nx:160,ny:20,velocity:.1,wallHeatFlux:5000,conductivity:.069},r=await solveChannel(config,"flux"),ch=r.channel!;
    const rise=2*config.wallHeatFlux*config.length*config.nu/(config.conductivity*config.pr*config.velocity*config.height),estimate=fluxWallEstimate(config)!;
    expect(r.converged).toBe(true);expect(Math.abs(ch.energyImbalance!)).toBeLessThan(1e-4);
    expect(Math.abs((ch.bulkOutletTemperatureK-config.inletTemperature)/rise-1)).toBeLessThan(1e-3);
    expect(ch.nusselt.at(-1)![1]/8.235).toBeGreaterThan(1);expect(ch.nusselt.at(-1)![1]/8.235).toBeLessThan(1.05);
    expect(Math.abs(ch.maxWallTemperatureK!-estimate.wall)/(estimate.wall-config.inletTemperature)).toBeLessThan(.05);
  },240000);
});

// Masrouri and Yagoobi's two-channel device without EHD: HFE-7100 at 1 cm/s and 20 °C, the lower channel heated at 0.75 W/cm² on both walls, gravity down.
describe.skipIf(process.env.BEAM_TEST_OPENFOAM!=="1")("real OpenFOAM parallel channels",()=>{
  async function solve(config:typeof defaultParallelChannels,caseId:string){
    const root=await mkdtemp(join(tmpdir(),"beam-foam-parallel-")),executor=new LocalExecutor(root);
    const spec=(stage:"mesh"|"solve"):ProcessJobSpec=>({version:1,kind:"process",title:caseId,executable:"beam:openfoam",args:[],inputs:stage==="mesh"?[]:[{assetId:"mesh",path:"mesh-input.json"}],outputs:simulationOutputs(stage,config),timeoutSeconds:600,simulation:{image:OPENFOAM_IMAGE,caseId,revision:1,stage,config,...(stage==="solve"?{meshJobId:"mesh"}:{})}});
    async function finish(id:string){const until=Date.now()+590000;while(Date.now()<until){const s=await executor.inspect({backend:executor.backend,id});if(s.state!=="running"){expect(s.error,s.log).toBe(null);expect(s.state,s.log).toBe("succeeded");return;}await new Promise(r=>setTimeout(r,250));}throw new Error("Integration timed out");}
    try{
      await executor.submit("mesh",spec("mesh"),[]);await finish("mesh");
      const mesh=SimulationReport.parse(JSON.parse(await readFile(join(root,"mesh/work/report.json"),"utf8")));expect(mesh.meshOk).toBe(true);
      const bytes=await readFile(join(root,"mesh/work/mesh.json"));
      await executor.submit("solve",spec("solve"),[{path:"mesh-input.json",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),url:`data:application/json;base64,${bytes.toString("base64")}`}]);await finish("solve");
      return{report:SimulationReport.parse(JSON.parse(await readFile(join(root,"solve/work/report.json"),"utf8"))),fields:SimulationFields.parse(JSON.parse(await readFile(join(root,"solve/work/fields.json"),"utf8")))};
    }finally{await executor.cancelSubmission("mesh");await executor.cancelSubmission("solve");await rm(root,{recursive:true,force:true});}
  }
  it("splits an unheated, gravity-free flow evenly between identical channels",async()=>{
    const config={...defaultParallelChannels,channels:[{heatFlux:0},{heatFlux:0}],gravity:"off" as const,cellsAcross:10,cellsAlong:35,duration:2,frames:4};
    const {report}=await solve(config,"symmetric"),p=report.parallel!;
    expect(Math.abs(report.massImbalance!)).toBeLessThan(1e-6);expect(Math.abs(p.inflow/(config.velocity*.015)-1)).toBeLessThan(1e-6);
    expect(Math.abs(p.flows[0]!/p.flows[1]!-1)).toBeLessThan(1e-3);expect(Math.abs((p.flows[0]!+p.flows[1]!)/p.inflow-1)).toBeLessThan(1e-3);
    expect(p.heatInputW).toBe(0);expect(p.maxHeatedWallTemperatureK).toBe(null);
  },300000);
  it("keeps the hydrostatic head in a vertical device's static pressure",async()=>{
    const config={...defaultParallelChannels,channels:[{heatFlux:0},{heatFlux:0}],gravity:"upflow" as const,cellsAcross:10,cellsAlong:35,duration:1,frames:2};
    const {report,fields}=await solve(config,"upflow");
    // Flow runs up 0.21 m of HFE-7100; between the centres of the first and last 2 mm cell columns that is ρ·g·0.208 ≈ 3.08 kPa, and friction adds well under 1 Pa.
    const head=config.density*9.81*(2*config.manifoldLength+config.channelLength-config.manifoldLength/35);
    expect(Math.abs(report.pressureDropPa!/head-1)).toBeLessThan(.005);expect(Math.max(...fields.pressure)-Math.min(...fields.pressure)).toBeGreaterThan(.99*head);
  },300000);
  it("draws more of the flow through the heated lower channel as buoyancy builds, and walls pass the boiling point by 5 s",async()=>{
    const {report,fields}=await solve(defaultParallelChannels,"masrouri"),p=report.parallel!;
    expect(report.meshOk).toBe(true);expect(report.cells).toBe(11200);expect(report.physicalTime).toBeCloseTo(5);expect(report.maxCourant!).toBeLessThan(1);
    expect(Math.abs(report.massImbalance!)).toBeLessThan(1e-6);expect(p.history).toHaveLength(defaultParallelChannels.frames);
    // Uniform 1 cm/s across the 1.5 cm manifold: 1.5 cm²/s in. The channels carry all of it, and the heated channel's share grows over time.
    expect(Math.abs(p.inflow/1.5e-4-1)).toBeLessThan(1e-6);expect(Math.abs((p.flows[0]!+p.flows[1]!)/p.inflow-1)).toBeLessThan(.01);
    const share=(f:number[])=>f[0]!/(f[0]!+f[1]!);expect(share(p.history[0]!.flows)).toBeLessThan(.52);expect(share(p.flows)).toBeGreaterThan(.54);expect(share(p.flows)).toBeLessThan(.62);
    // 0.75 W/cm² on both walls of a 7 cm channel is 1,050 W per metre of depth; after 5 s most of it is still warming the fluid.
    expect(p.heatInputW).toBeCloseTo(1050);expect(p.heatCarriedOutW).toBeGreaterThan(0);expect(p.heatCarriedOutW/p.heatInputW).toBeLessThan(.5);
    expect(p.maxHeatedWallTemperatureK!).toBeGreaterThan(defaultParallelChannels.boilingPoint!);expect(Math.min(...fields.temperature)).toBeGreaterThan(defaultParallelChannels.inletTemperature-.5);
    expect(p.exitBulkTemperaturesK[0]!).toBeGreaterThan(p.exitBulkTemperaturesK[1]!);
    // Only fluid leaving a channel counts, so each exit temperature lies within the temperatures actually present.
    for(const t of p.exitBulkTemperaturesK){expect(t!).toBeGreaterThan(defaultParallelChannels.inletTemperature-.5);expect(t!).toBeLessThan(Math.max(...fields.temperature));}
    expect(parallelSetupChecks(defaultParallelChannels).find(k=>k.id==="single-phase")!.status).toBe("fail");
  },600000);
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
