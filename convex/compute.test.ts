import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async(ctx:any,token:string)=>{if(token!=="valid")throw new Error("Invalid token");return ctx.db.get("runner");}}));
import { resumeSimulationExport, submit, submitForRun, claim, cancel, report, approve, get, forRun, stageInput, inputs, publishOutput, saveSimulation, submitSimulation, saveSimulationForRun, submitSimulationForRun, simulationForRun, selectSimulation, selectSimulationForRun, studyContext, study, workspaceStudies } from "./compute";

import { defaultChannel, defaultCylinder, defaultPlanar, OPENFOAM_IMAGE } from "../packages/contracts/src/simulation";

const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
const spec={version:1,kind:"process",title:"Flow",executable:"python3",args:["analysis.py"],inputs:[],outputs:[],timeoutSeconds:60};
function fixture(){
  const tables:Record<string,any[]>={
    users:[{_id:"user",githubLogin:"alice"}],chats:[{_id:"chat",workspaceId:"ws",private:true,members:["alice"]}],
    members:[{workspaceId:"ws",githubLogin:"alice"}],runners:[{_id:"runner",ownerLogin:"alice",online:true,lastSeen:Date.now(),computeBackend:"local-process"}],
    agents:[{_id:"agent",permissionMode:"auto"}],runs:[{_id:"run",chatId:"chat",runnerId:"runner",agentId:"agent",dispatchedBy:"alice",state:"working"}],
    simulationCases:[],simulationRevisions:[],computeJobs:[],computeAssets:[],files:[],messages:[],
  };
  const db:any={get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,
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
