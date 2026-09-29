import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async(ctx:any,token:string)=>{if(token!=="valid")throw new Error("Invalid token");return ctx.db.get("runner");}}));
import { cloudForRun, launching, pending, releasing, released, resumeSimulationExport, submit, submitForRun, claim, cancel, report, approve, get, forRun, stageInput, inputs, publishOutput, saveSimulation, submitSimulation, saveSimulationForRun, submitSimulationForRun, simulationForRun, selectSimulation, selectSimulationForRun, studyContext, study, workspaceStudies, modelUploadUrl, stageModel, stageModelForRun, modelFiles, publishResults } from "./compute";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { get as getBudget, setAllowance } from "./computeBudget";

import { defaultChannel, defaultCylinder, defaultPlanar, OPENFOAM_IMAGE, modelWindTunnel, type Model3D } from "../packages/contracts/src/simulation";

const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
const spec={version:1,kind:"process",title:"Flow",executable:"python3",args:["analysis.py"],inputs:[],outputs:[],timeoutSeconds:60};
function fixture(){
  const tables:Record<string,any[]>={
    users:[{_id:"user",githubLogin:"alice"}],chats:[{_id:"chat",workspaceId:"ws",private:true,members:["alice"]}],
    members:[{workspaceId:"ws",githubLogin:"alice"}],runners:[{_id:"runner",ownerLogin:"alice",online:true,lastSeen:Date.now(),computeBackend:"local-process"}],
    agents:[{_id:"agent",permissionMode:"auto"}],runs:[{_id:"run",chatId:"chat",runnerId:"runner",agentId:"agent",dispatchedBy:"alice",state:"working"}],
    simulationCases:[],simulationRevisions:[],computeJobs:[],computeAssets:[],files:[],messages:[],
  };
  const db:any={normalizeId:(_:string,id:string)=>id,get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,
    query:(table:string)=>{const filters:[string,unknown][]=[];let descending=false;const rows=()=>{const items=(tables[table]??[]).filter(r=>filters.every(([k,v])=>r[k]===v));return descending?items.slice().reverse():items;};const chain:any={withIndex:(_:string,fn:any)=>{const q={eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;}};fn(q);return chain;},order:(dir:string)=>{descending=dir==="desc";return chain;},collect:async()=>rows(),take:async(n:number)=>rows().slice(0,n),first:async()=>rows()[0]??null};return chain;},
    insert:async(table:string,value:any)=>{const id=`${table}-${tables[table]!.length}`;tables[table]!.push({_id:id,_creationTime:Date.now(),...value});return id;},
    patch:async(id:string,value:any)=>Object.assign(await db.get(id),value),
    system:{get:async()=>({size:4,sha256:"hash",contentType:"application/octet-stream"})},
  };
  const ctx:any={db,storage:{getUrl:vi.fn(async()=>"https://storage.test/result"),generateUploadUrl:vi.fn(async()=>"https://storage.test/upload")}};
  const enqueue=(key="key",s=spec)=>call(submit,ctx,{chatId:"chat",runnerId:"runner",requestKey:key,spec:s});
  return {ctx,tables,enqueue};
}

it("deduplicates submissions and rejects reuse for a different job",async()=>{
  const {ctx,tables,enqueue}=fixture();const id=await enqueue();expect(await enqueue()).toBe(id);
  expect(tables.computeJobs).toHaveLength(1);expect(tables.messages).toHaveLength(1);
  await expect(enqueue("key",{...spec,title:"Different"})).rejects.toThrow("different job");
  tables.runners![0].online=false;expect(await enqueue()).toBe(id);
  await expect(enqueue("new")).rejects.toThrow("offline");
});
it("enforces private membership, runner ownership/sharing, and asset chat scope",async()=>{
  const {ctx,tables,enqueue}=fixture();tables.chats![0].members=["bob"];
  await expect(enqueue()).rejects.toThrow("private chat");tables.chats![0].members=["alice"];
  tables.runners![0].ownerLogin="bob";tables.members!.push({workspaceId:"ws",githubLogin:"bob"});
  await expect(enqueue()).rejects.toThrow("not shared");tables.runners![0].allowSharedRuns=true;
  const id=await enqueue();expect(id).toBeTruthy();
  tables.computeAssets!.push({_id:"asset",chatId:"another",size:4});
  await expect(enqueue("foreign",{...spec,inputs:[{assetId:"asset",path:"a"}]} as any)).rejects.toThrow("not in this chat");
  tables.members=[];await expect(call(get,ctx,{id})).rejects.toThrow("not a member");
});
it("keeps plan mode read-only and routes non-auto jobs through requester approval",async()=>{
  const {ctx,tables}=fixture();const args={token:"valid",runId:"run",requestKey:"key",spec};
  tables.agents![0].permissionMode="plan";await expect(call(submitForRun,ctx,args)).rejects.toThrow("Plan mode");
  tables.agents![0].permissionMode="ask";const id=await call(submitForRun,ctx,args);
  expect(tables.computeJobs![0].state).toBe("awaiting-approval");expect(await call(claim,ctx,{token:"valid",id})).toBe(false);
  await call(approve,ctx,{id});expect(tables.computeJobs![0].state).toBe("queued");
  expect(await call(claim,ctx,{token:"valid",id})).toBe(true);
});
it("claims once and serializes jobs on the same local runner",async()=>{
  const {ctx,tables,enqueue}=fixture();const first=await enqueue(),second=await enqueue("second");
  expect(await call(claim,ctx,{token:"valid",id:first})).toBe(true);
  expect(await call(claim,ctx,{token:"valid",id:first})).toBe(false);
  expect(await call(claim,ctx,{token:"valid",id:second})).toBe(false);
  await call(report,ctx,{token:"valid",id:first,state:"succeeded",log:"done",error:null});
  expect(await call(claim,ctx,{token:"valid",id:second})).toBe(true);
  await call(report,ctx,{token:"valid",id:first,state:"running",log:"late",error:null});
  expect(tables.computeJobs![0].state).toBe("succeeded");
});
it("cancels queued work immediately and waits for acknowledgement of running work",async()=>{
  const {ctx,tables,enqueue}=fixture();const queued=await enqueue();await call(cancel,ctx,{id:queued});
  expect(tables.computeJobs![0].state).toBe("cancelled");expect(await call(claim,ctx,{token:"valid",id:queued})).toBe(false);
  const running=await enqueue("running");await call(claim,ctx,{token:"valid",id:running});await call(cancel,ctx,{id:running});
  expect(tables.computeJobs![1].state).toBe("preparing");expect(tables.computeJobs![1].cancelRequestedAt).toBeTypeOf("number");
  await call(report,ctx,{token:"valid",id:running,state:"succeeded",log:"",error:null});
  expect(tables.computeJobs![1].state).toBe("cancelled");
});
it("publishes required results before marking success, and publication is idempotent",async()=>{
  const {ctx,tables,enqueue}=fixture();const id=await enqueue("results",{...spec,outputs:["result.csv"]} as any);
  await call(claim,ctx,{token:"valid",id});const update={token:"valid",id,state:"succeeded",log:"",error:null};
  await expect(call(report,ctx,update)).rejects.toThrow("not yet published");
  await call(report,ctx,{...update,state:"publishing"});
  await expect(call(publishOutput,ctx,{token:"valid",id,path:"other.csv",storageId:"blob"})).rejects.toThrow("not requested");
  const result=await call(publishOutput,ctx,{token:"valid",id,path:"result.csv",storageId:"blob"});
  expect(await call(publishOutput,ctx,{token:"valid",id,path:"result.csv",storageId:"blob2"})).toBe(result);
  await call(report,ctx,update);expect(tables.computeJobs![0].state).toBe("succeeded");
  expect((await call(get,ctx,{id})).outputs[0]).toMatchObject({path:"result.csv",url:"https://storage.test/result"});
});
it("retains input hashes and denies revoked dispatchers access to snapshots or results",async()=>{
  const {ctx,tables,enqueue}=fixture();const assetId=await call(stageInput,ctx,{token:"valid",runId:"run",storageId:"blob",path:"system/controlDict"});
  const id=await enqueue("snapshot",{...spec,inputs:[{assetId,path:"system/controlDict"}]} as any);
  expect(await call(inputs,ctx,{token:"valid",id})).toEqual([{path:"system/controlDict",size:4,sha256:"hash",url:"https://storage.test/result"}]);
  tables.chats![0].members=[];
  await expect(call(inputs,ctx,{token:"valid",id})).rejects.toThrow("revoked");
  await expect(call(forRun,ctx,{token:"valid",runId:"run",id})).rejects.toThrow("revoked");
});

it("versions case edits, blocks conflicts and binds jobs to matching saved meshes",async()=>{
  const {ctx,tables}=fixture();tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};
  tables.runs![0].state="landed";
  const saved=await call(saveSimulation,ctx,{chatId:"chat",name:"Channel",config:defaultChannel});
  const args={chatId:"chat",runnerId:"runner",caseId:saved.id,revision:1,stage:"mesh",requestKey:"mesh"};
  const mesh=await call(submitSimulation,ctx,args);
  await expect(call(submitSimulation,ctx,{...args,requestKey:"solve",stage:"solve",meshJobId:mesh})).rejects.toThrow();
  tables.computeJobs![0].state="succeeded";tables.computeJobs![0].outputs=["mesh-asset"];
  tables.computeAssets!.push({_id:"mesh-asset",chatId:"chat",path:"mesh.json",size:500,jobId:mesh});
  const edited=await call(saveSimulation,ctx,{chatId:"chat",id:saved.id,revision:1,name:"Channel",config:{...defaultChannel,velocity:.03}});
  expect(edited.revision).toBe(2);expect(tables.computeJobs![0].spec.simulation.config.velocity).toBe(.02);
  await expect(call(saveSimulation,ctx,{chatId:"chat",id:saved.id,revision:1,name:"Conflict",config:defaultChannel})).rejects.toThrow("Another edit");
  expect(await call(submitSimulation,ctx,args)).toBe(mesh); // retry works after revision changes
  const solve=await call(submitSimulation,ctx,{...args,revision:2,requestKey:"solve",stage:"solve",meshJobId:mesh});
  expect((await ctx.db.get(solve)).spec.inputs).toEqual([{assetId:"mesh-asset",path:"mesh-input.json"}]);
  await call(saveSimulation,ctx,{chatId:"chat",id:saved.id,revision:2,name:"Channel",config:{...defaultChannel,nx:80}});
  await expect(call(submitSimulation,ctx,{...args,revision:3,requestKey:"bad-mesh",stage:"solve",meshJobId:mesh})).rejects.toThrow("matching mesh");
  tables.runners![0].openfoam.ready=false;
  await expect(call(submitSimulation,ctx,{...args,revision:3,requestKey:"missing-runtime"})).rejects.toThrow();
  tables.chats![0].members=[];
  await expect(call(saveSimulation,ctx,{chatId:"chat",name:"Hidden",config:defaultChannel})).rejects.toThrow();
});
it("runs studies in the cfd environment on a runner that has it, with the mesh from the mesh job's results",async()=>{
  const {ctx,tables}=fixture(),cfd="ghcr.io/supraluminalintelligence/beam-env-cfd@sha256:"+"c".repeat(64);
  tables.runners![0].openfoam={ready:true,image:cfd,message:"OpenFOAM 2512 · cfd environment"};tables.runs![0].state="landed";
  const saved=await call(saveSimulation,ctx,{chatId:"chat",name:"Channel",config:defaultChannel});
  const args={chatId:"chat",runnerId:"runner",caseId:saved.id,revision:1,stage:"mesh",requestKey:"mesh"};
  const mesh=await call(submitSimulation,ctx,args),meshJob=await ctx.db.get(mesh);
  expect(meshJob.spec).toMatchObject({kind:"environment",environment:{name:"cfd",image:cfd},command:"beam-recipe",inputs:[],recipe:{caseId:saved.id,revision:1,stage:"mesh"}});
  meshJob.state="succeeded";meshJob.outputs=["recipe-mesh"];
  tables.computeAssets!.push({_id:"recipe-mesh",chatId:"chat",path:"beam/out/recipe/mesh.json",size:500,jobId:mesh});
  const solve=await ctx.db.get(await call(submitSimulation,ctx,{...args,stage:"solve",meshJobId:mesh,requestKey:"solve"}));
  expect(solve.spec).toMatchObject({kind:"environment",inputs:[{assetId:"recipe-mesh",path:"mesh-input.json"}],recipe:{stage:"solve",meshJobId:mesh}});
  // Studies list their jobs whichever way they ran.
  expect((await call(study,ctx,{id:saved.id})).jobs.map((j:any)=>[j.simulation.stage,j.environment])).toEqual([["solve","cfd"],["mesh","cfd"]]);
  // A runner whose cfd image changed since it reported is refused, as a changed OpenFOAM image is.
  tables.runners![0].openfoam.image=OPENFOAM_IMAGE;
  await expect(call(submit,ctx,{chatId:"chat",runnerId:"runner",requestKey:"stale",spec:{...meshJob.spec}})).rejects.toThrow("different OpenFOAM runtime");
});
it("simulation tools enforce agent permissions and use the same case and job records",async()=>{
  const {ctx,tables}=fixture();tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};
  tables.agents![0].permissionMode="plan";
  await expect(call(saveSimulationForRun,ctx,{token:"valid",runId:"run",name:"Channel",config:defaultChannel})).rejects.toThrow("Plan mode");
  tables.agents![0].permissionMode="ask";
  const saved=await call(saveSimulationForRun,ctx,{token:"valid",runId:"run",name:"Channel",config:defaultChannel});
  const id=await call(submitSimulationForRun,ctx,{token:"valid",runId:"run",caseId:saved.id,revision:1,stage:"mesh",requestKey:"tool-mesh"});
  expect((await ctx.db.get(id)).state).toBe("awaiting-approval");
  expect((await call(simulationForRun,ctx,{token:"valid",runId:"run"})).cases).toHaveLength(1);
  tables.runs![0].state="done";
  await expect(call(submitSimulationForRun,ctx,{token:"valid",runId:"run",caseId:saved.id,revision:1,stage:"mesh",requestKey:"late"})).rejects.toThrow("ended");
});

it("routes transient cylinder cases through the same immutable mesh and output contracts",async()=>{
 const {ctx,tables}=fixture();tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};
 tables.runs![0].state="landed";
  const saved=await call(saveSimulation,ctx,{chatId:"chat",name:"Wake",config:defaultCylinder});
 const args={chatId:"chat",runnerId:"runner",caseId:saved.id,revision:1,stage:"mesh",requestKey:"wake-mesh"};
 const mesh=await call(submitSimulation,ctx,args);tables.computeJobs![0].state="succeeded";tables.computeJobs![0].outputs=["mesh-asset"];
 tables.computeAssets!.push({_id:"mesh-asset",chatId:"chat",path:"mesh.json",size:500,jobId:mesh});
 const solve=await call(submitSimulation,ctx,{...args,stage:"solve",meshJobId:mesh,requestKey:"wake-solve"});
 expect((await ctx.db.get(solve)).spec.outputs).toContain("frames.bin");
 await call(saveSimulation,ctx,{chatId:"chat",id:saved.id,revision:1,name:"Wake",config:{...defaultCylinder,diameter:.02}});
 await expect(call(submitSimulation,ctx,{...args,revision:2,stage:"solve",meshJobId:mesh,requestKey:"stale-wake"})).rejects.toThrow("matching mesh");
});

it("creates one live study card, preserves revisions and deduplicates unchanged saves",async()=>{
 const {ctx,tables}=fixture();tables.runs![0].state="landed";
 const a=await call(saveSimulation,ctx,{chatId:"chat",name:"Wake",config:defaultCylinder});
 expect(tables.chats![0].activeStudyId).toBe(a.id);expect(tables.messages).toHaveLength(1);expect(tables.messages![0].simulationStudyId).toBe(a.id);
 await call(saveSimulation,ctx,{chatId:"chat",id:a.id,revision:1,name:"Wake",config:defaultCylinder});
 expect(tables.simulationRevisions).toHaveLength(1);
 await call(saveSimulation,ctx,{chatId:"chat",id:a.id,revision:1,name:"Faster wake",config:{...defaultCylinder,velocity:.2}});
 expect(tables.simulationRevisions!.map(r=>r.config.velocity)).toEqual([.1,.2]);expect(tables.messages).toHaveLength(1);
 expect((await call(study,ctx,{id:a.id})).revision).toBe(2);
 expect((await call(studyContext,ctx,{chatId:"chat"})).activeStudyId).toBe(a.id);
});
it("pins a run's working study and requires explicit agent switching",async()=>{
 const {ctx,tables}=fixture();tables.runs![0].state="landed";
 const a=await call(saveSimulation,ctx,{chatId:"chat",name:"A",config:defaultCylinder});
 const b=await call(saveSimulation,ctx,{chatId:"chat",name:"B",config:defaultChannel});
 tables.runs![0].state="working";tables.runs![0].studyId=a.id;
 expect((await call(simulationForRun,ctx,{token:"valid",runId:"run"})).activeStudyId).toBe(a.id);
 await expect(call(saveSimulationForRun,ctx,{token:"valid",runId:"run",id:b.id,revision:1,name:"B",config:defaultChannel})).rejects.toThrow("Select this study");
 await expect(call(selectSimulation,ctx,{chatId:"chat",caseId:a.id})).rejects.toThrow("agent is working");
 await call(selectSimulationForRun,ctx,{token:"valid",runId:"run",caseId:a.id});expect(tables.chats![0].activeStudyId).toBe(a.id);
 await call(selectSimulationForRun,ctx,{token:"valid",runId:"run",caseId:b.id});expect(tables.runs![0].studyId).toBe(b.id);
 tables.agents![0].permissionMode="plan";await expect(call(selectSimulationForRun,ctx,{token:"valid",runId:"run",caseId:a.id})).rejects.toThrow("Plan mode");
});
it("keeps workspace discovery inside existing chat permissions and binds selections to their chat",async()=>{
 const {ctx,tables}=fixture();tables.runs![0].state="landed";
 tables.chats!.push({_id:"public",workspaceId:"ws",title:"Public",private:false,members:[]},{_id:"private",workspaceId:"ws",private:true,members:["bob"]},{_id:"deleted",workspaceId:"ws",state:"deleted",private:false},{_id:"foreign",workspaceId:"other",private:false});
 tables.simulationCases!.push(...["public","private","deleted","foreign"].map(chatId=>({_id:`study-${chatId}`,chatId,name:chatId,revision:1,config:defaultCylinder})));
 expect((await call(workspaceStudies,ctx,{chatId:"chat"})).map((s:any)=>s.name)).toEqual(["public"]);
 await expect(call(selectSimulation,ctx,{chatId:"chat",caseId:"study-public"})).rejects.toThrow("unavailable in this chat");
 await expect(call(study,ctx,{id:"study-private"})).rejects.toThrow("private chat");
 await call(selectSimulation,ctx,{chatId:"public",caseId:"study-public"});expect((await ctx.db.get("public")).activeStudyId).toBe("study-public");
});
it("updates the live card for mesh and solve jobs without adding one card per job",async()=>{
 const {ctx,tables}=fixture();tables.runs![0].state="landed";tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};
 const a=await call(saveSimulation,ctx,{chatId:"chat",name:"Wake",config:defaultCylinder});
 const mesh=await call(submitSimulation,ctx,{chatId:"chat",runnerId:"runner",caseId:a.id,revision:1,stage:"mesh",requestKey:"card-mesh"});
 expect(tables.messages).toHaveLength(1);const result=await call(study,ctx,{id:a.id});expect(result.jobs[0]._id).toBe(mesh);expect(result.jobs[0].state).toBe("queued");
});

it("saves agent-defined geometry and preserves exact boundaries through immutable mesh and solve jobs",async()=>{
 const {ctx,tables}=fixture();tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};
 const saved=await call(saveSimulationForRun,ctx,{token:"valid",runId:"run",name:"Three cylinders",config:defaultPlanar});
 const mesh=await call(submitSimulationForRun,ctx,{token:"valid",runId:"run",caseId:saved.id,revision:1,stage:"mesh",requestKey:"planar-mesh"});
 expect(tables.computeJobs![0].spec.simulation.config.bodies).toEqual(defaultPlanar.bodies);
 expect(tables.computeJobs![0].spec.outputs).toContain("mesh-view.json");
 tables.computeJobs![0].state="succeeded";tables.computeJobs![0].outputs=["mesh-asset"];
 tables.computeAssets!.push({_id:"mesh-asset",chatId:"chat",path:"mesh.json",size:500,jobId:mesh});
 await call(submitSimulationForRun,ctx,{token:"valid",runId:"run",caseId:saved.id,revision:1,stage:"solve",meshJobId:mesh,requestKey:"planar-solve"});
 expect(tables.computeJobs![1].spec.simulation.config.boundaries).toEqual(defaultPlanar.boundaries);
 const edited=await call(saveSimulationForRun,ctx,{token:"valid",runId:"run",id:saved.id,revision:1,name:"Three cylinders",config:{...defaultPlanar,meshSize:.003}});
 await expect(call(submitSimulationForRun,ctx,{token:"valid",runId:"run",caseId:saved.id,revision:edited.revision,stage:"solve",meshJobId:mesh,requestKey:"stale-mesh"})).rejects.toThrow();
 expect(tables.computeJobs![1].spec.simulation.config.meshSize).toBe(defaultPlanar.meshSize);
});

it("only lets the owning runner resume a recoverable export and still requires outputs",async()=>{
 const {ctx,tables,enqueue}=fixture();const id=await enqueue();const job=tables.computeJobs![0];
 job.state="failed";job.handle={backend:"local-process",id};job.log="End\nMaximum call stack size exceeded";job.endedAt=123;job.spec={...spec,outputs:["report.json"],simulation:{stage:"solve"}};
 await expect(call(resumeSimulationExport,ctx,{token:"invalid",id})).rejects.toThrow("Invalid token");
 job.runnerId="other";await expect(call(resumeSimulationExport,ctx,{token:"valid",id})).rejects.toThrow();job.runnerId="runner";
 job.cancelRequestedAt=1;await expect(call(resumeSimulationExport,ctx,{token:"valid",id})).rejects.toThrow("Cancelled");delete job.cancelRequestedAt;
 job.log="solver diverged";await expect(call(resumeSimulationExport,ctx,{token:"valid",id})).rejects.toThrow("not a recoverable");job.log="Maximum call stack size exceeded";
 expect(await call(resumeSimulationExport,ctx,{token:"valid",id})).toBe(true);expect(job.state).toBe("publishing");expect(job.endedAt).toBeUndefined();expect(job.log).toContain("solver is not rerun");
 // Use a regular valid process manifest to test the shared publication guard.
 job.spec={...spec,outputs:["report.json"]};
 await expect(call(report,ctx,{token:"valid",id,state:"succeeded",log:"recovered",error:null})).rejects.toThrow("Outputs are not yet published");
 expect(await call(resumeSimulationExport,ctx,{token:"valid",id})).toBe(false);
});

it("stages imported models in the chat and meshes only from the surface a study names",async()=>{
  const {ctx,tables}=fixture();tables.runners![0].openfoam={ready:true,image:OPENFOAM_IMAGE,message:"ready"};tables.runs![0].state="landed";
  await expect(call(stageModel,ctx,{chatId:"chat",storageId:"blob"})).rejects.toThrow("binary STL");
  const sha="n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=";ctx.db.system.get=async()=>({size:84+50*12,sha256:sha,contentType:"application/octet-stream"});
  expect(await call(modelUploadUrl,ctx,{chatId:"chat"})).toBe("https://storage.test/upload");
  const staged=await call(stageModel,ctx,{chatId:"chat",storageId:"car-blob"});
  expect(staged).toEqual({assetId:"computeAssets-0",sha256:sha,size:684});
  const agent=await call(stageModelForRun,ctx,{token:"valid",runId:"run",storageId:"agent-blob"});
  expect(tables.computeAssets![1]).toMatchObject({chatId:"chat",author:"alice",path:"model.stl"});expect(agent.assetId).toBe("computeAssets-1");
  expect(await call(modelFiles,ctx,{assetIds:[staged.assetId,"missing"]})).toEqual([{assetId:staged.assetId,url:"https://storage.test/result",size:684}]);
  const model:Model3D={assetId:staged.assetId,file:"car.stl",sha256:sha,triangles:12,min:[0,0,0],max:[4.5,1.8,1.4],area:41.4,volume:11.34,projectedArea:[2.52,6.3,8.1]};
  const config=modelWindTunnel(model,{scale:1});
  const saved=await call(saveSimulation,ctx,{chatId:"chat",name:"Car",config});
  const args={chatId:"chat",runnerId:"runner",caseId:saved.id,revision:1,stage:"mesh",requestKey:"car-mesh"};
  const mesh=await call(submitSimulation,ctx,args);
  expect((await ctx.db.get(mesh)).spec.inputs).toEqual([{assetId:staged.assetId,path:"models/model.stl"}]);
  // A study pointing at a surface with another checksum, or in another chat, cannot mesh.
  const forged=await call(saveSimulation,ctx,{chatId:"chat",id:saved.id,revision:1,name:"Car",config:{...config,bodies:[{...config.bodies[0]!,model:{...model,sha256:"x".repeat(44)}}]}});
  await expect(call(submitSimulation,ctx,{...args,revision:forged.revision,requestKey:"forged"})).rejects.toThrow("import it again");
  tables.computeAssets![0].chatId="elsewhere";
  await expect(call(modelFiles,ctx,{assetIds:[staged.assetId]})).rejects.toThrow();
});

const envSpec={version:1,kind:"environment",title:"Cantilever",environment:{name:"fea",image:"ghcr.io/supraluminalintelligence/beam-env-fea@sha256:"+"a".repeat(64)},command:"mpirun -n 2 python /beam/benchmarks/cantilever.py",inputs:[],machine:"local",timeoutSeconds:600};
const cantilever=JSON.parse(readFileSync(new URL("../packages/contracts/src/fixtures/cantilever/manifest.json",import.meta.url),"utf8"));
it("runs environment jobs locally, and in the cloud only on machines Beam supports",async()=>{
  const {tables,enqueue}=fixture();
  await expect(enqueue("cloud",{...envSpec,machine:"32-core"} as any)).rejects.toThrow("not available yet");
  await enqueue("env",envSpec as any);
  expect(tables.computeJobs![0]).toMatchObject({state:"queued",spec:{kind:"environment",command:envSpec.command}});
  expect(tables.messages![0].text).toBe("Compute job: Cantilever");
});
it("publishes an environment job's beam/out files and a validated manifest before success",async()=>{
  const {ctx,tables,enqueue}=fixture();const id=await enqueue("env",envSpec as any);
  await call(claim,ctx,{token:"valid",id});const done={token:"valid",id,state:"succeeded",log:"",error:null};
  await call(report,ctx,{...done,state:"publishing"});
  await expect(call(publishOutput,ctx,{token:"valid",id,path:"notes.txt",storageId:"b0"})).rejects.toThrow("not requested");
  const results={token:"valid",id,manifest:cantilever,unpublished:[]};
  await expect(call(publishResults,ctx,results)).rejects.toThrow("manifest.json first");
  await call(publishOutput,ctx,{token:"valid",id,path:"beam/out/manifest.json",storageId:"b1"});
  await call(publishOutput,ctx,{token:"valid",id,path:"beam/out/preview/beam.json",storageId:"b2"});
  await expect(call(report,ctx,done)).rejects.toThrow("Results are not yet published");
  await expect(call(publishResults,ctx,{...results,manifest:{...cantilever,checks:[{...cantilever.checks[0],status:"maybe"}]}})).rejects.toThrow();
  await expect(call(publishResults,ctx,{...results,unpublished:[{path:"/etc/passwd",reason:"x"}]})).rejects.toThrow("unpublished");
  await call(publishResults,ctx,{...results,unpublished:[{path:"beam/out/fields/beam.vtu",reason:"larger than 20 MB; kept on the machine"}]});
  await call(report,ctx,done);
  expect(tables.computeJobs![0].state).toBe("succeeded");
  expect(tables.computeJobs![0].results.manifest.quantities[0].name).toBe("tip_deflection");
  const detail=await call(forRun,ctx,{token:"valid",runId:"run",id});
  expect(detail.spec.kind).toBe("environment");expect(detail.outputs).toHaveLength(2);
  expect((await call(forRun,ctx,{token:"valid",runId:"run"}))[0]).toMatchObject({title:"Cantilever",environment:"fea",simulation:null});
});
it("keeps a job that wrote no manifest successful, with no results",async()=>{
  const {ctx,tables,enqueue}=fixture();const id=await enqueue("env",envSpec as any);
  await call(claim,ctx,{token:"valid",id});await call(report,ctx,{token:"valid",id,state:"publishing",log:"",error:null});
  await call(publishResults,ctx,{token:"valid",id,manifest:null,unpublished:[]});
  await call(report,ctx,{token:"valid",id,state:"succeeded",log:"",error:null});
  expect(tables.computeJobs![0]).toMatchObject({state:"succeeded",results:{manifest:null}});
  await expect(call(publishResults,ctx,{token:"valid",id,manifest:null,unpublished:[]})).rejects.toThrow("not publishing");
});

const GATEWAY="g".repeat(40);
process.env.BEAM_GATEWAY_TOKEN_SHA256=createHash("sha256").update(GATEWAY).digest("hex");
const cloudSpec={...envSpec,machine:"chat"};
function cloudFixture(allowanceCents=100){
  const f=fixture();f.tables.workspaces=[{_id:"ws",createdBy:"user"}];
  f.tables.computeBudgets=allowanceCents===null?[]:[{_id:"budget",workspaceId:"ws",allowanceCents,reservedCents:0,spentCents:0}];
  return {...f,budget:()=>f.tables.computeBudgets![0],job:(n=0)=>f.tables.computeJobs![n]};
}
it("queues cloud jobs for the gateway, reserving their authorized amount from the workspace budget",async()=>{
  const none=cloudFixture(null as any);await expect(none.enqueue("c",cloudSpec as any)).rejects.toThrow("$0.00 of cloud compute budget left");
  const {ctx,tables,enqueue,budget,job}=cloudFixture();tables.runners![0].online=false;
  const id=await enqueue("c",cloudSpec as any);
  // 4 cores and 16 GiB at Modal's Sandbox prices for a 600 s job's whole machine life of 2,700 s.
  expect(job()).toMatchObject({backend:"modal-sandbox",state:"queued",billing:{authorizedCents:72,spentCents:0,reserved:true}});
  expect(budget().reservedCents).toBe(72);
  await expect(enqueue("c2",cloudSpec as any)).rejects.toThrow("authorized up to $0.72 but the workspace has $0.28");
  expect(await call(pending,ctx,{token:"valid"})).toEqual([]);
  await expect(call(claim,ctx,{token:"valid",id})).rejects.toThrow("Not this runner's job");
  await expect(call(claim,ctx,{token:"x".repeat(40),id})).rejects.toThrow("Not this runner's job");
  expect((await call(pending,ctx,{token:GATEWAY})).map((j:any)=>j._id)).toEqual([id]);
  expect(await call(claim,ctx,{token:GATEWAY,id})).toBe(true);
  // Local jobs on the same runner are not held up by the cloud job.
  tables.runners![0].online=true;const local=await enqueue("l");expect(await call(claim,ctx,{token:"valid",id:local})).toBe(true);
});
it("meters a cloud job from its machine's creation, stops it at its authorized limit and settles once the machine is released",async()=>{
  const {ctx,enqueue,budget,job}=cloudFixture();const id=await enqueue("c",cloudSpec as any);
  await call(claim,ctx,{token:GATEWAY,id});job().startedAt=Date.now()-3600_000;
  // Claimed an hour ago but no machine yet: nothing is metered.
  await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null});expect(job().billing.spentCents).toBe(0);
  // A machine recovered after a restart, with no launch time: metered from the launch window, not the claim.
  await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null,handle:{backend:"modal-sandbox",id:"sb-1"}});
  expect(job().billing.spentCents).toBe(8);
  expect(job().billing.meteredFrom).toBeTypeOf("number");
  job().billing.meteredFrom=Date.now()-600_000;await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null});
  expect(job().billing.spentCents).toBe(16);expect(job().cancelRequestedAt).toBeUndefined();
  job().billing.meteredFrom=Date.now()-3*3600_000;await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null});
  expect(job()).toMatchObject({cancelRequestedAt:expect.any(Number),error:"Stopped at its authorized limit of $0.72",billing:{spentCents:72}});
  await call(report,ctx,{token:GATEWAY,id,state:"failed",log:"",error:"The cloud machine stopped before the job's results were collected"});
  // Finished, but its machine is not yet confirmed stopped: the reservation holds and the gateway sees it.
  expect(job()).toMatchObject({state:"cancelled",error:"Stopped at its authorized limit of $0.72",awaitingRelease:true,billing:{reserved:true}});
  expect(budget()).toMatchObject({reservedCents:72,spentCents:0});
  expect((await call(pending,ctx,{token:GATEWAY})).map((j:any)=>j._id)).toEqual([id]);
  await expect(call(released,ctx,{token:"valid",id})).rejects.toThrow("Not this runner's job");
  await call(released,ctx,{token:GATEWAY,id});await call(released,ctx,{token:GATEWAY,id});
  expect(job()).toMatchObject({awaitingRelease:undefined,billing:{spentCents:72,reserved:false}});
  expect(budget()).toMatchObject({reservedCents:0,spentCents:72});
  expect(await call(pending,ctx,{token:GATEWAY})).toEqual([]);
});
it("releases what a finished cloud job did not spend, and records its provenance from Beam's records",async()=>{
  const {ctx,enqueue,budget,job}=cloudFixture();const id=await enqueue("c",cloudSpec as any);
  await call(claim,ctx,{token:GATEWAY,id});
  await call(report,ctx,{token:GATEWAY,id,state:"publishing",log:"",error:null,exitCode:0,handle:{backend:"modal-sandbox",id:"sb-1"}});
  job().billing.meteredFrom=Date.now()-60_000;
  await call(publishOutput,ctx,{token:GATEWAY,id,path:"beam/out/manifest.json",storageId:"b1"});
  await call(publishResults,ctx,{token:GATEWAY,id,manifest:null,unpublished:[]});
  await call(report,ctx,{token:GATEWAY,id,state:"succeeded",log:"",error:null,exitCode:0});
  await call(released,ctx,{token:GATEWAY,id});
  expect(job()).toMatchObject({state:"succeeded",billing:{spentCents:2,reserved:false}});
  expect(budget()).toMatchObject({reservedCents:0,spentCents:2});
  const detail=await call(get,ctx,{id});expect(detail.runnerName).toBe("Chat machine · 4 cores");
  expect(detail.provenance).toMatchObject({environment:cloudSpec.environment,command:cloudSpec.command,machine:"chat",backend:"modal-sandbox",exitCode:0,outputs:[{path:"beam/out/manifest.json",sha256:"hash",size:4}]});
});
it("meters a cloud machine from its launch and settles it at its confirmed stop",async()=>{
  const {ctx,enqueue,budget,job}=cloudFixture();const id=await enqueue("c",cloudSpec as any);
  await call(claim,ctx,{token:GATEWAY,id});
  const claimedAt=Date.now()-60_000;job().startedAt=claimedAt;
  await expect(call(launching,ctx,{token:"valid",id})).rejects.toThrow("Not this runner's job");
  await call(launching,ctx,{token:GATEWAY,id});const launchedAt=job().launchedAt;
  expect(launchedAt).toBeGreaterThanOrEqual(claimedAt);
  // The report reaches Convex late; metering still starts at the recorded launch.
  await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null,handle:{backend:"modal-sandbox",id:"sb-1"}});
  expect(job().billing.meteredFrom).toBe(launchedAt);
  await expect(call(launching,ctx,{token:GATEWAY,id})).rejects.toThrow("not waiting for a machine");
  const meteredFrom=Date.now()-3600_000;job().billing.meteredFrom=meteredFrom;
  await call(report,ctx,{token:GATEWAY,id,state:"failed",log:"",error:"x"});
  // Stopped ten minutes in, though Convex hears of it only now: ten minutes are charged, not the hour.
  await call(released,ctx,{token:GATEWAY,id,stoppedAt:meteredFrom+600_000});
  expect(job().billing).toMatchObject({spentCents:16,reserved:false});
  expect(budget()).toMatchObject({reservedCents:0,spentCents:16});
});
it("settles a machine found already stopped at when its release began",async()=>{
  const {ctx,enqueue,budget,job}=cloudFixture();const id=await enqueue("c",cloudSpec as any);
  await call(claim,ctx,{token:GATEWAY,id});await call(launching,ctx,{token:GATEWAY,id});
  await call(report,ctx,{token:GATEWAY,id,state:"running",log:"",error:null,handle:{backend:"modal-sandbox",id:"sb-1"}});
  const meteredFrom=Date.now()-3600_000;job().billing.meteredFrom=meteredFrom;
  await call(report,ctx,{token:GATEWAY,id,state:"failed",log:"",error:"x"});
  await call(releasing,ctx,{token:GATEWAY,id});job().releasingAt=meteredFrom+600_000;
  // A retry after an outage records nothing new, and the machine is found already stopped.
  await call(releasing,ctx,{token:GATEWAY,id});expect(job().releasingAt).toBe(meteredFrom+600_000);
  await call(released,ctx,{token:GATEWAY,id});
  expect(budget()).toMatchObject({reservedCents:0,spentCents:16});
});
it("reserves an approval-gated cloud job only when approved, and releases it on cancel",async()=>{
  const {ctx,tables,budget,job}=cloudFixture();tables.agents![0].permissionMode="ask";
  const id=await call(submitForRun,ctx,{token:"valid",runId:"run",requestKey:"c",spec:cloudSpec});
  expect(job().state).toBe("awaiting-approval");expect(budget().reservedCents).toBe(0);
  await call(approve,ctx,{id});expect(job().billing.reserved).toBe(true);expect(budget().reservedCents).toBe(72);
  await call(cancel,ctx,{id});expect(job()).toMatchObject({state:"cancelled",billing:{reserved:false,spentCents:0}});
  expect(budget()).toMatchObject({reservedCents:0,spentCents:0});
  await expect(cloudFixture().enqueue("big",{...cloudSpec,machine:"96-core"} as any)).rejects.toThrow("not available yet");
  await expect(cloudFixture().enqueue("long",{...cloudSpec,timeoutSeconds:86400} as any)).rejects.toThrow("at most 23.4 hours");
});
it("refuses cloud jobs until the deployment has a gateway, and tells agents and settings whether cloud runs",async()=>{
  const {ctx,tables,enqueue}=cloudFixture(500);
  expect(await call(cloudForRun,ctx,{token:"valid",runId:"run"})).toEqual({enabled:true,availableCents:500});
  expect(await call(getBudget,ctx,{workspaceId:"ws"})).toMatchObject({enabled:true,allowanceCents:500,availableCents:500,canEdit:true});
  const hash=process.env.BEAM_GATEWAY_TOKEN_SHA256;delete process.env.BEAM_GATEWAY_TOKEN_SHA256;
  try{
    await expect(enqueue("c",cloudSpec as any)).rejects.toThrow("not switched on");
    // A value no token's digest could match does not switch cloud on either.
    process.env.BEAM_GATEWAY_TOKEN_SHA256="changeme";
    expect(await call(cloudForRun,ctx,{token:"valid",runId:"run"})).toMatchObject({enabled:false});
    delete process.env.BEAM_GATEWAY_TOKEN_SHA256;
    // A job submitted while cloud was on is not queued, or charged, if cloud is off by its approval.
    tables.computeJobs!.push({_id:"gated",chatId:"chat",runnerId:"runner",requestedBy:"alice",state:"awaiting-approval",spec:cloudSpec,backend:"modal-sandbox",billing:{centsPerHour:100,authorizedCents:75,spentCents:0,reserved:false}});
    await expect(call(approve,ctx,{id:"gated"})).rejects.toThrow("not switched on");
    expect(tables.computeJobs!.find(j=>j._id==="gated")).toMatchObject({state:"awaiting-approval",billing:{reserved:false}});
    expect(tables.computeBudgets![0]).toMatchObject({reservedCents:0});
    expect(await call(cloudForRun,ctx,{token:"valid",runId:"run"})).toEqual({enabled:false,availableCents:500});
  }finally{process.env.BEAM_GATEWAY_TOKEN_SHA256=hash;}
  // A workspace with no budget yet reads as $0, and only its creator may change it.
  const none=cloudFixture(null as any);none.tables.workspaces![0].createdBy="someone";
  expect(await call(getBudget,none.ctx,{workspaceId:"ws"})).toMatchObject({allowanceCents:0,availableCents:0,canEdit:false});
});
it("lets only the workspace's creator set its compute budget",async()=>{
  const {ctx,tables}=cloudFixture(null as any);
  await call(setAllowance,ctx,{workspaceId:"ws",allowanceCents:5000});expect(tables.computeBudgets![0]).toMatchObject({allowanceCents:5000,reservedCents:0});
  await expect(call(setAllowance,ctx,{workspaceId:"ws",allowanceCents:-1})).rejects.toThrow("between");
  tables.workspaces![0].createdBy="someone";await expect(call(setAllowance,ctx,{workspaceId:"ws",allowanceCents:1})).rejects.toThrow("creator");
});
