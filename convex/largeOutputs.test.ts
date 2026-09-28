import { afterEach, expect, it, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async(ctx:any,token:string)=>{if(token!=="valid")throw new Error("Invalid token");return ctx.db.get("runner");}}));
import { getFunctionName } from "convex/server";
import { submit, claim, report, publishOutput, hasOutput, get, cancel, startLargeOutput, largeOutputUrls, recordLargeOutput, outputUrl, largeOutputTargetQuery, largeOutputForViewerQuery, insertLargeOutputMutation } from "./compute";
import { objectStore } from "./objectStore";

const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
const MiB=2**20, GiB=2**30;
const envSpec={version:1,kind:"environment",title:"Bracket",environment:{name:"fea",image:"ghcr.io/supraluminalintelligence/beam-env-fea@sha256:"+"a".repeat(64)},command:"true",inputs:[],machine:"local",timeoutSeconds:600};
// A 2M-vertex preview: its positions buffer is 24,000,000 bytes, over the Convex limit.
const manifest={version:1,fields:[{name:"p",label:"Part",full:"fields/p.vtu",preview:"preview/p.json",cells:1,arrays:[]}],files:[{path:"raw/solver.h5",label:"raw",kind:"file",bytes:1}]};
const preview={version:1,kind:"surface",vertices:2_000_000,triangles:1,positions:"preview/p.positions.f32",indices:"preview/p.indices.u32",arrays:[]};
const ENV={R2_ACCOUNT_ID:"0123456789abcdef0123456789abcdef",R2_ACCESS_KEY_ID:"test-access-key",R2_SECRET_ACCESS_KEY:"test-secret-never-returned",R2_BUCKET:"beam-results"};
const configure=()=>Object.assign(process.env,ENV);
afterEach(()=>{for(const k of [...Object.keys(ENV),"R2_ENDPOINT"])delete process.env[k];});

async function fixture(){
  const tables:Record<string,any[]>={
    users:[{_id:"user",githubLogin:"alice"}],chats:[{_id:"chat",workspaceId:"ws",private:true,members:["alice"]}],
    members:[{workspaceId:"ws",githubLogin:"alice"}],runners:[{_id:"runner",ownerLogin:"alice",online:true,lastSeen:Date.now(),computeBackend:"local-process"}],
    computeJobs:[],computeAssets:[],computeObjects:[],files:[],messages:[],
  };
  const db:any={normalizeId:(_:string,id:string)=>id,get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,
    query:(table:string)=>{const filters:[string,unknown][]=[];const rows=()=>(tables[table]??[]).filter(r=>filters.every(([k,v])=>r[k]===v));const chain:any={withIndex:(_:string,fn:any)=>{const q={eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;}};fn(q);return chain;},order:()=>chain,collect:async()=>rows(),take:async(n:number)=>rows().slice(0,n),first:async()=>rows()[0]??null};return chain;},
    insert:async(table:string,value:any)=>{const id=`${table}-${tables[table]!.length}`;tables[table]!.push({_id:id,_creationTime:Date.now(),...value});return id;},
    patch:async(id:string,value:any)=>Object.assign(await db.get(id),value),
    system:{get:async()=>({size:4,sha256:"hash",contentType:"application/octet-stream"})},
  };
  const blobs:Record<string,string>={"b-manifest":JSON.stringify(manifest),"b-preview":JSON.stringify(preview)};
  const ctx:any={db,storage:{getUrl:vi.fn(async()=>"https://storage.test/result"),generateUploadUrl:vi.fn(async()=>"https://storage.test/upload")}};
  // An action's context: its internal queries and mutations run against the same tables.
  const internals:Record<string,any>={"compute:largeOutputTargetQuery":largeOutputTargetQuery,"compute:largeOutputForViewerQuery":largeOutputForViewerQuery,"compute:insertLargeOutputMutation":insertLargeOutputMutation};
  const run=(ref:any,args:any)=>call(internals[getFunctionName(ref)],ctx,args);
  const actx:any={runQuery:run,runMutation:run,storage:{get:async(id:string)=>id in blobs?new Blob([blobs[id]!]):null}};
  const id=await call(submit,ctx,{chatId:"chat",runnerId:"runner",requestKey:"env",spec:envSpec});
  await call(claim,ctx,{token:"valid",id});
  await call(report,ctx,{token:"valid",id,state:"publishing",log:"",error:null,exitCode:0});
  return {ctx,actx,tables,id,job:()=>tables.computeJobs![0],publishManifest:async()=>{
    await call(publishOutput,ctx,{token:"valid",id,path:"beam/out/manifest.json",storageId:"b-manifest"});
    await call(publishOutput,ctx,{token:"valid",id,path:"beam/out/preview/p.json",storageId:"b-preview"});
  }};
}
const args=(id:string,path="beam/out/fields/p.vtu",size=2*GiB)=>({token:"valid",id,path,size});

it("reads R2 configuration from the environment, defaulting the endpoint from the account", ()=>{
  expect(objectStore({})).toBeNull();
  expect(objectStore({...ENV,R2_BUCKET:""})).toBeNull();
  expect(objectStore({...ENV,R2_BUCKET:"Bad_Bucket"})).toBeNull();
  expect(objectStore({...ENV,R2_ACCOUNT_ID:"not-an-account"})).toBeNull();
  expect(objectStore(ENV)).toMatchObject({endpoint:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",bucket:"beam-results",region:"auto"});
  expect(objectStore({...ENV,R2_ACCOUNT_ID:"",R2_ENDPOINT:"http://127.0.0.1:9000"})).toMatchObject({endpoint:"http://127.0.0.1:9000"});
  expect(objectStore({...ENV,R2_ENDPOINT:"http://127.0.0.1:9000/bucket"})).toBeNull();
});

it("lets only the job's runner start a large upload, while the job publishes, after its manifest", async()=>{
  configure();const f=await fixture();
  await expect(call(startLargeOutput,f.actx,{...args(f.id),token:"other"})).rejects.toThrow("Invalid token");
  await expect(call(startLargeOutput,f.actx,args(f.id))).rejects.toThrow("Publish beam/out/manifest.json first");
  await f.publishManifest();
  await expect(call(startLargeOutput,f.actx,args(f.id,"notes/x.bin"))).rejects.toThrow("not requested");
  await expect(call(startLargeOutput,f.actx,args(f.id,"beam/out/../x"))).rejects.toThrow();
  await expect(call(startLargeOutput,f.actx,args(f.id,"beam/out/fields/p.vtu",20*MiB))).rejects.toThrow("20 MB or less");
  // Only files the published manifest names, or buffers its previews describe at their exact length.
  await expect(call(startLargeOutput,f.actx,args(f.id,"beam/out/fields/other.vtu"))).rejects.toThrow("not requested");
  await expect(call(startLargeOutput,f.actx,args(f.id,"beam/out/preview/p.positions.f32",24_000_001))).rejects.toThrow("preview/p.positions.f32 is 24000001 bytes; its preview says 24000000");
  const start=await call(startLargeOutput,f.actx,args(f.id,"beam/out/preview/p.positions.f32",24_000_000));
  expect(start).toMatchObject({ok:true,key:`jobs/${f.id}/beam/out/preview/p.positions.f32`,partBytes:64*MiB});
  expect(start.createUrl).toMatch(new RegExp(`^https://0123456789abcdef0123456789abcdef\\.r2\\.cloudflarestorage\\.com/beam-results/jobs/${f.id}/beam/out/preview/p\\.positions\\.f32\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&`));
  expect(start.createUrl).toContain("&uploads=&");
  expect(JSON.stringify(start)).not.toContain(ENV.R2_SECRET_ACCESS_KEY);
  f.job().cancelRequestedAt=Date.now();
  await expect(call(startLargeOutput,f.actx,args(f.id))).rejects.toThrow("not publishing");
});

it("keeps files on the machine, saying why, past the caps or without an object store", async()=>{
  const f=await fixture();await f.publishManifest();
  expect(await call(startLargeOutput,f.actx,args(f.id))).toEqual({ok:false,reason:"larger than 20 MB; kept on the machine, since large-output storage is not configured"});
  configure();
  expect(await call(startLargeOutput,f.actx,args(f.id,"beam/out/fields/p.vtu",5*GiB+1))).toEqual({ok:false,reason:"larger than 5 GiB; kept on the machine"});
  f.tables.computeObjects!.push({_id:"o1",jobId:f.id,path:"beam/out/raw/solver.h5",size:19*GiB,sha256:"x",key:"k"});
  expect(await call(startLargeOutput,f.actx,args(f.id,"beam/out/fields/p.vtu",2*GiB))).toEqual({ok:false,reason:"past this job's 20 GiB of large outputs; kept on the machine"});
  await expect(call(largeOutputUrls,f.actx,{...args(f.id,"beam/out/fields/p.vtu",2*GiB),uploadId:"u",parts:[1]})).rejects.toThrow("past this job's 20 GiB");
});

it("signs part, complete and abort URLs for the parts the file has", async()=>{
  configure();const f=await fixture();await f.publishManifest();
  const a={...args(f.id,"beam/out/fields/p.vtu",130*MiB),uploadId:"abc/def=="};
  await expect(call(largeOutputUrls,f.actx,{...a,parts:[4]})).rejects.toThrow("uploads in 3 parts");
  await expect(call(largeOutputUrls,f.actx,{...a,parts:[1,1]})).rejects.toThrow();
  await expect(call(largeOutputUrls,f.actx,{...a,uploadId:""})).rejects.toThrow();
  const urls=await call(largeOutputUrls,f.actx,{...a,parts:[1,3]});
  expect(urls.parts.map((p:any)=>p.partNumber)).toEqual([1,3]);
  const part=new URL(urls.parts[1].url);
  expect(part.searchParams.get("partNumber")).toBe("3");expect(part.searchParams.get("uploadId")).toBe("abc/def==");
  expect(part.searchParams.get("X-Amz-Expires")).toBe("3600");
  expect(new URL(urls.completeUrl).searchParams.get("uploadId")).toBe("abc/def==");
  expect(urls.completeUrl).not.toBe(urls.abortUrl);
});

it("records a finished upload once, shows it in the job with no standing URL, and signs downloads for chat members only", async()=>{
  configure();const f=await fixture();await f.publishManifest();
  const sha="ab".repeat(32),key=`jobs/${f.id}/beam/out/fields/p.vtu`,rec={...args(f.id),sha256:sha,key};
  await expect(call(recordLargeOutput,f.actx,{...rec,key:"jobs/other/beam/out/fields/p.vtu"})).rejects.toThrow("key does not match");
  await expect(call(recordLargeOutput,f.actx,{...rec,sha256:"XYZ"})).rejects.toThrow("SHA-256");
  const id=await call(recordLargeOutput,f.actx,rec);
  expect(await call(recordLargeOutput,f.actx,rec)).toBe(id);
  await expect(call(recordLargeOutput,f.actx,{...rec,sha256:"cd".repeat(32)})).rejects.toThrow("different file");
  expect(f.tables.computeObjects).toEqual([expect.objectContaining({chatId:"chat",jobId:f.id,path:"beam/out/fields/p.vtu",size:2*GiB,sha256:sha,key,author:"alice"})]);
  await expect(call(startLargeOutput,f.actx,args(f.id))).rejects.toThrow("already published");
  expect(await call(hasOutput,f.ctx,{token:"valid",id:f.id,path:"beam/out/fields/p.vtu"})).toBe(true);
  expect(await call(hasOutput,f.ctx,{token:"valid",id:f.id,path:"beam/out/raw/solver.h5"})).toBe(false);

  const detail=await call(get,f.ctx,{id:f.id});
  expect(detail.outputs.find((o:any)=>o.path==="beam/out/fields/p.vtu")).toEqual({id,path:"beam/out/fields/p.vtu",size:2*GiB,sha256:sha,url:null,storage:"r2"});
  expect(detail.outputs.find((o:any)=>o.path==="beam/out/manifest.json")).toMatchObject({url:"https://storage.test/result",storage:"convex"});

  const link=await call(outputUrl,f.actx,{id:f.id,path:"beam/out/fields/p.vtu"});
  const url=new URL(link.url);
  expect(url.pathname).toBe(`/beam-results/${key}`);
  expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="p.vtu"');
  expect(link.expiresAt).toBeGreaterThan(Date.now());
  expect(link.url).not.toContain(ENV.R2_SECRET_ACCESS_KEY);
  await expect(call(outputUrl,f.actx,{id:f.id,path:"beam/out/manifest.json"})).rejects.toThrow("not in large-output storage");
  f.tables.chats![0].members=["bob"];
  await expect(call(outputUrl,f.actx,{id:f.id,path:"beam/out/fields/p.vtu"})).rejects.toThrow("private chat");
  f.tables.chats![0].members=["alice"];f.tables.members=[];
  await expect(call(outputUrl,f.actx,{id:f.id,path:"beam/out/fields/p.vtu"})).rejects.toThrow("not a member");
  f.tables.members=[{workspaceId:"ws",githubLogin:"alice"}];delete process.env.R2_BUCKET;
  await expect(call(outputUrl,f.actx,{id:f.id,path:"beam/out/fields/p.vtu"})).rejects.toThrow("not configured");
});

it("refuses to record an upload once the job is cancelled", async()=>{
  configure();const f=await fixture();await f.publishManifest();
  await call(cancel,f.ctx,{id:f.id});
  await expect(call(recordLargeOutput,f.actx,{...args(f.id),sha256:"ab".repeat(32),key:`jobs/${f.id}/beam/out/fields/p.vtu`})).rejects.toThrow("not publishing");
  expect(f.tables.computeObjects).toEqual([]);
});
