import { expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async(ctx:any,token:string)=>{if(token!=="valid")throw new Error("Invalid token");return ctx.db.get("runner");}}));
import { submit, submitForRun, claim, cancel, report, approve, get, forRun, stageInput, inputs, publishOutput } from "./compute";

const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
const spec={version:1,kind:"process",title:"Flow",executable:"python3",args:["analysis.py"],inputs:[],outputs:[],timeoutSeconds:60};
function fixture(){
  const tables:Record<string,any[]>={
    users:[{_id:"user",githubLogin:"alice"}],chats:[{_id:"chat",workspaceId:"ws",private:true,members:["alice"]}],
    members:[{workspaceId:"ws",githubLogin:"alice"}],runners:[{_id:"runner",ownerLogin:"alice",online:true,lastSeen:Date.now(),computeBackend:"local-process"}],
    agents:[{_id:"agent",permissionMode:"auto"}],runs:[{_id:"run",chatId:"chat",runnerId:"runner",agentId:"agent",dispatchedBy:"alice",state:"working"}],
    computeJobs:[],computeAssets:[],files:[],messages:[],
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
