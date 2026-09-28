import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async(ctx:any,token:string)=>{if(token!=="valid")throw new Error("Invalid token");return ctx.db.get("runner");}}));
import { get, list, forRun, run, saveParameters, saveVersionForRun, runVersionForRun } from "./simulations";
import { approve, claim, publishOutput, publishResults, report, saveSimulation, simulationCases, simulationForRun, study, studyContext, workspaceStudies } from "./compute";
import { defaultChannel } from "../packages/contracts/src/simulation";

const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
const IMAGE="ghcr.io/supraluminalintelligence/beam-env-fea@sha256:"+"a".repeat(64);
const cantilever=JSON.parse(readFileSync(new URL("../packages/contracts/src/fixtures/cantilever/manifest.json",import.meta.url),"utf8"));
function fixture(mode="auto"){
  const tables:Record<string,any[]>={
    users:[{_id:"user",githubLogin:"alice"}],chats:[{_id:"chat",workspaceId:"ws",title:"bracket",private:false,members:[]},{_id:"secret",workspaceId:"ws",title:"secret",private:true,members:["bob"]}],
    members:[{workspaceId:"ws",githubLogin:"alice"}],runners:[{_id:"runner",ownerLogin:"alice",online:true,lastSeen:Date.now(),computeBackend:"local-process"}],
    agents:[{_id:"agent",permissionMode:mode}],runs:[{_id:"run",chatId:"chat",runnerId:"runner",agentId:"agent",dispatchedBy:"alice",state:"working"}],
    simulationCases:[],simulationRevisions:[],computeJobs:[],computeAssets:[{_id:"a1",chatId:"chat",path:"solve.py",size:10},{_id:"a2",chatId:"chat",path:"solve.py",size:12},{_id:"foreign",chatId:"secret",path:"x.py",size:1}],files:[],messages:[],
  };
  const db:any={normalizeId:(_:string,id:string)=>id,get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,
    query:(table:string)=>{const filters:[string,unknown][]=[];let descending=false;const rows=()=>{const items=(tables[table]??[]).filter(r=>filters.every(([k,v])=>r[k]===v));return descending?items.slice().reverse():items;};const chain:any={withIndex:(_:string,fn:any)=>{const q={eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;}};fn(q);return chain;},order:(dir:string)=>{descending=dir==="desc";return chain;},collect:async()=>rows(),take:async(n:number)=>rows().slice(0,n),first:async()=>rows()[0]??null};return chain;},
    insert:async(table:string,value:any)=>{const id=`${table}-${tables[table]!.length}`;tables[table]!.push({_id:id,_creationTime:Date.now(),...value});return id;},
    patch:async(id:string,value:any)=>Object.assign(await db.get(id),value),
    system:{get:async()=>({size:4,sha256:"hash",contentType:"application/octet-stream"})},
  };
  const ctx:any={db,storage:{getUrl:vi.fn(async()=>"https://storage.test/result"),generateUploadUrl:vi.fn(async()=>"https://storage.test/upload")}};
  return {ctx,tables};
}
const setup=(asset="a1",radius=2)=>({kind:"files",environment:{name:"fea",image:IMAGE},command:"python solve.py",files:[{path:"solve.py",assetId:asset}],parameters:[{name:"fillet_radius",value:radius,unit:"mm"}],timeoutSeconds:600});
const save=(ctx:any,extra:any={})=>call(saveVersionForRun,ctx,{token:"valid",runId:"run",name:"Bracket",setup:setup(),...extra});

it("creates a files simulation with a card, as the chat's working simulation",async()=>{
  const {ctx,tables}=fixture();
  const saved=await save(ctx,{note:"First try"});
  expect(saved).toEqual({id:"simulationCases-0",version:1,unchanged:false});
  expect(tables.simulationCases![0]).toMatchObject({kind:"files",workspaceId:"ws",config:null,revision:1});
  expect(tables.messages![0]).toMatchObject({text:"Simulation: Bracket",simulationId:saved.id,author:"agent:agent"});
  expect(tables.messages![0].simulationStudyId).toBeUndefined();
  expect(tables.chats![0].activeStudyId).toBe(saved.id);
  expect(tables.runs![0].studyId).toBe(saved.id);
});
it("saves each change as the next version, refuses stale edits, and saves nothing for an unchanged setup",async()=>{
  const {ctx,tables}=fixture();const {id}=await save(ctx);
  expect(await save(ctx,{id,version:1})).toEqual({id,version:1,unchanged:true});
  expect(await save(ctx,{id,version:1,setup:setup("a2",4),note:"Wider fillet"})).toEqual({id,version:2,unchanged:false});
  await expect(save(ctx,{id,version:1,setup:setup("a1",6)})).rejects.toThrow("Another edit saved v2");
  expect(tables.simulationRevisions!.map(r=>r.revision)).toEqual([1,2]);
  expect(tables.messages).toHaveLength(1);
  const sim=await call(get,ctx,{id});
  expect(sim.versions.map((v:any)=>v.version)).toEqual([1,2]);
  expect(sim.versions[1]).toMatchObject({note:"Wider fillet",changes:["fillet_radius: 2 mm → 4 mm","~ solve.py"]});
});
it("shows a derived version's changes against the version it came from, as a sweep saves them",async()=>{
  const {ctx}=fixture();const {id}=await save(ctx);
  await save(ctx,{id,version:1,from:1,setup:setup("a1",4)});
  await save(ctx,{id,version:2,from:1,setup:setup("a1",8)});
  await expect(save(ctx,{id,version:3,from:7,setup:setup("a1",9)})).rejects.toThrow("No v7");
  const sim=await call(get,ctx,{id});
  expect(sim.versions.map((v:any)=>[v.version,v.from,v.changes])).toEqual([[1,null,[]],[2,1,["fillet_radius: 2 mm → 4 mm"]],[3,1,["fillet_radius: 2 mm → 8 mm"]]]);
});
it("only snapshots files staged in this chat, and plan mode cannot save",async()=>{
  await expect(save(fixture().ctx,{setup:setup("foreign")})).rejects.toThrow("not in this chat");
  await expect(save(fixture("plan").ctx)).rejects.toThrow("Plan mode");
});
it("runs a version as an environment job with its parameters, linked to the version, without another chat message",async()=>{
  const {ctx,tables}=fixture();const {id}=await save(ctx);
  const jobId=await call(runVersionForRun,ctx,{token:"valid",runId:"run",id,version:1,machine:"local",requestKey:"k"});
  expect(tables.computeJobs![0].spec).toMatchObject({kind:"environment",title:"Bracket · v1",command:"python solve.py",inputs:[{path:"solve.py",assetId:"a1"}],parameters:[{name:"fillet_radius",value:2,unit:"mm"}],simulation:{caseId:id,version:1}});
  expect(tables.computeJobs![0].state).toBe("queued");
  expect(tables.messages).toHaveLength(1);
  await expect(call(runVersionForRun,ctx,{token:"valid",runId:"run",id,version:3,machine:"local",requestKey:"k2"})).rejects.toThrow("no v3");
  await expect(call(runVersionForRun,ctx,{token:"valid",runId:"run",id,version:1,machine:"96-core",requestKey:"k3"})).rejects.toThrow("not available yet");
  // Results in brief on the simulation.
  await call(claim,ctx,{token:"valid",id:jobId});await call(report,ctx,{token:"valid",id:jobId,state:"publishing",log:"",error:null});
  await call(publishOutput,ctx,{token:"valid",id:jobId,path:"beam/out/manifest.json",storageId:"b1"});
  await call(publishResults,ctx,{token:"valid",id:jobId,manifest:cantilever,unpublished:[]});
  await call(report,ctx,{token:"valid",id:jobId,state:"succeeded",log:"",error:null});
  const sim=await call(get,ctx,{id});
  expect(sim.jobs[0]).toMatchObject({version:1,state:"succeeded",results:{checks:{pass:4,review:0,fail:0,"not-evaluated":0},flagged:[]}});
  expect(sim.jobs[0].results.headline.map((q:any)=>q.name)).toEqual(["tip_deflection","midspan_bending_stress"]);
});
it("routes an agent's run through the requester's approval outside auto mode; a person's run needs none",async()=>{
  const {ctx,tables}=fixture("ask");const {id}=await save(ctx);
  const jobId=await call(runVersionForRun,ctx,{token:"valid",runId:"run",id,version:1,machine:"local",requestKey:"k"});
  expect(tables.computeJobs![0].state).toBe("awaiting-approval");
  await call(approve,ctx,{id:jobId});expect(tables.computeJobs![0].state).toBe("queued");
  await call(run,ctx,{id,version:1,runnerId:"runner",machine:"local",requestKey:"mine"});
  expect(tables.computeJobs![1].state).toBe("queued");
});
it("lets a person change parameters as the next version, but not while the agent works",async()=>{
  const {ctx,tables}=fixture();const {id}=await save(ctx);
  await expect(call(saveParameters,ctx,{id,version:1,parameters:[{name:"fillet_radius",value:4,unit:"mm"}]})).rejects.toThrow("agent is working");
  tables.runs![0].state="landed";
  expect(await call(saveParameters,ctx,{id,version:1,parameters:[{name:"fillet_radius",value:4,unit:"mm"}],note:"From the app"})).toMatchObject({version:2});
  expect((await call(get,ctx,{id})).versions[1].changes).toEqual(["fillet_radius: 2 mm → 4 mm"]);
});
it("absorbs studies: lists both kinds, while the study functions installed apps call see only recipes",async()=>{
  const {ctx,tables}=fixture();tables.runs![0].state="landed";
  const recipe=await call(saveSimulation,ctx,{chatId:"chat",name:"Channel",config:defaultChannel});
  tables.runs![0].state="working";const files=await save(ctx);
  expect(tables.simulationCases![0]).toMatchObject({kind:"recipe",workspaceId:"ws"});
  tables.simulationCases![0].updatedAt=1;tables.simulationCases![1].updatedAt=2;
  expect((await call(list,ctx,{workspaceId:"ws"})).map((s:any)=>[s.name,s.kind])).toEqual([["Bracket","files"],["Channel","recipe"]]);
  expect((await call(forRun,ctx,{token:"valid",runId:"run"})).simulations.map((s:any)=>s.kind).sort()).toEqual(["files","recipe"]);
  expect((await call(simulationCases,ctx,{chatId:"chat"})).map((s:any)=>s._id)).toEqual([recipe.id]);
  expect((await call(studyContext,ctx,{chatId:"chat"})).studies.map((s:any)=>s._id)).toEqual([recipe.id]);
  expect((await call(workspaceStudies,ctx,{chatId:"chat"})).map((s:any)=>s.id)).toEqual([recipe.id]);
  expect((await call(simulationForRun,ctx,{token:"valid",runId:"run"})).cases.map((s:any)=>s._id)).toEqual([recipe.id]);
  expect(await call(study,ctx,{id:files.id})).toBeNull();
  await expect(call(saveSimulation,ctx,{chatId:"chat",id:files.id,revision:1,name:"x",config:defaultChannel})).rejects.toThrow("unavailable");
});
it("keeps private chats' simulations out of other members' lists",async()=>{
  const {ctx,tables}=fixture();tables.simulationCases!.push({_id:"hidden",chatId:"secret",name:"Hidden",kind:"files",config:null,revision:1,updatedAt:1,updatedBy:"bob"});
  expect((await call(list,ctx,{workspaceId:"ws"})).map((s:any)=>s.id)).not.toContain("hidden");
  await expect(call(get,ctx,{id:"hidden"})).rejects.toThrow("private chat");
});
