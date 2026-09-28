import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";
import { ExecutorUnavailable, type ComputeExecutor } from "@beam/contracts";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { reconcileJob } from "./watch";

afterEach(()=>vi.unstubAllGlobals());
function setup() {
  const job = { _id:"job", state:"publishing", backend:"local-process", log:"", handle:{backend:"local-process",id:"job"}, spec:{version:1,kind:"process",title:"Test",executable:"python3",args:[],inputs:[],outputs:["result.csv"],timeoutSeconds:60} } as unknown as Doc<"computeJobs">;
  let published = false;
  const client = {
    query: vi.fn(async (ref: never)=>{
      const name=getFunctionName(ref);
      if(name==="compute:pending")return [job];
      if(name==="compute:hasOutput")return published;
      if(name==="compute:inputs")return [];
      throw new Error(name);
    }),
    mutation: vi.fn(async (ref: never, args: Record<string,unknown>)=>{
      const name=getFunctionName(ref);
      if(name==="compute:report")Object.assign(job,args);
      else if(name==="compute:outputUploadUrl")return "https://upload.invalid";
      else if(name==="compute:publishOutput")published=true;
      else throw new Error(name);
    }),
  };
  const executor:ComputeExecutor={backend:"local-process",recover:vi.fn(async()=>null),cancelSubmission:vi.fn(async()=>{}),submit:vi.fn(async()=>job.handle!),inspect:vi.fn(async()=>({state:"succeeded" as const,log:"done",error:null,exitCode:0})),cancel:vi.fn(async()=>{}),readOutput:vi.fn(async()=>new Uint8Array([1]))};
  return {job,client,executor,run:()=>reconcileJob(client as unknown as ConvexClient,"token",executor,job)};
}
it("retries interrupted publication without resubmitting compute or duplicating outputs",async()=>{
  const s=setup();const fetcher=vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response(JSON.stringify({storageId:"blob"})));
  vi.stubGlobal("fetch",fetcher);
  await expect(s.run()).rejects.toThrow("offline");expect(s.job.state).toBe("publishing");
  await s.run();expect(s.job.state).toBe("succeeded");
  s.job.state="publishing";await s.run();
  expect(s.executor.submit).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2);
});
it("fails collection when a declared result is missing",async()=>{
  const s=setup();vi.mocked(s.executor.readOutput).mockRejectedValue(new Error("missing"));await s.run();
  expect(s.job.state).toBe("failed");expect(s.job.error).toContain("Could not collect result.csv");
});
it("acknowledges cancellation without publishing successful process outputs",async()=>{
  const s=setup();s.job.cancelRequestedAt=1;await s.run();expect(s.executor.cancel).toHaveBeenCalledWith(s.job.handle);
  expect(s.job.state).toBe("cancelled");expect(s.executor.readOutput).not.toHaveBeenCalled();
});
it("recovers a launch whose handle was not yet saved",async()=>{
  const s=setup();delete s.job.handle;s.job.state="preparing";s.job.spec.outputs=[];
  vi.mocked(s.executor.submit).mockResolvedValue({backend:"local-process",id:"job"});await s.run();
  expect(s.executor.submit).toHaveBeenCalledOnce();expect(s.job.handle).toEqual({backend:"local-process",id:"job"});expect(s.job.state).toBe("succeeded");
});

it("recovers an opaque backend handle before cancelling; never guesses its ID",async()=>{
 const s=setup();delete s.job.handle;s.job.state="preparing";s.job.cancelRequestedAt=1;
 const recovered={backend:"local-process",id:"scheduler-receipt-42"};
 vi.mocked(s.executor.recover).mockResolvedValue(recovered);await s.run();
 expect(s.executor.cancel).toHaveBeenCalledWith(recovered);expect(s.executor.submit).not.toHaveBeenCalled();expect(s.job.state).toBe("cancelled");
 expect(s.executor.cancelSubmission).toHaveBeenCalledWith("job");
});
it("does not launch a cancelled job that has no execution receipt",async()=>{
 const s=setup();delete s.job.handle;s.job.state="preparing";s.job.cancelRequestedAt=1;await s.run();
 expect(s.executor.submit).not.toHaveBeenCalled();expect(s.job.state).toBe("cancelled");
 expect(s.executor.cancelSubmission).toHaveBeenCalledWith("job");
});

it("publishes an environment job's manifest and the files it names, then records its results",async()=>{
  const s=setup();
  s.job.spec={version:1,kind:"environment",title:"Env",environment:{name:"fea",image:"ghcr.io/x/y@sha256:"+"a".repeat(64)},command:"true",inputs:[],machine:"local",timeoutSeconds:60};
  const manifest={version:1,series:[{name:"s",label:"s",data:"series/s.json",points:1,x:{label:"x"},y:{lines:["a"]}}],checks:[{id:"c",label:"c",status:"pass",stage:"post"}]};
  const files:Record<string,string>={"beam/out/manifest.json":JSON.stringify(manifest),"beam/out/series/s.json":JSON.stringify({x:[1],lines:[{name:"a",values:[2]}]})};
  vi.mocked(s.executor.readOutput).mockImplementation(async(_h,path)=>{if(!(path in files))throw new Error("ENOENT: no such file");return new TextEncoder().encode(files[path]);});
  const paths:string[]=[];let results:unknown;
  const mutate=s.client.mutation.getMockImplementation()!;
  s.client.mutation.mockImplementation(async(ref:never,args:Record<string,unknown>)=>{
    const name=getFunctionName(ref);
    if(name==="compute:publishOutput"){paths.push(String(args["path"]));return;}
    if(name==="compute:publishResults"){results=args;return;}
    return mutate(ref,args);
  });
  s.client.query.mockImplementation(async(ref:never)=>{const name=getFunctionName(ref);if(name==="compute:pending")return [s.job];if(name==="compute:hasOutput")return false;throw new Error(name);});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({storageId:"blob"}))));
  await s.run();
  expect(paths).toEqual(["beam/out/manifest.json","beam/out/series/s.json"]);
  expect(results).toMatchObject({manifest:{checks:[{id:"c",status:"pass"}]},unpublished:[]});
  expect(s.job.state).toBe("succeeded");
});
it("fails an environment job whose manifest is invalid, naming the problem",async()=>{
  const s=setup();
  s.job.spec={version:1,kind:"environment",title:"Env",environment:{name:"fea",image:"ghcr.io/x/y@sha256:"+"a".repeat(64)},command:"true",inputs:[],machine:"local",timeoutSeconds:60};
  vi.mocked(s.executor.readOutput).mockResolvedValue(new TextEncoder().encode('{"version":1,"checks":[{"id":"c","label":"c","status":"maybe","stage":"post"}]}'));
  await s.run();
  expect(s.job.state).toBe("failed");expect(s.job.error).toContain("manifest.json is invalid");
});
it("frees a cloud machine once the job's outcome is recorded, and settles only after the release succeeds",async()=>{
  const s=setup();const release=vi.fn(async()=>1234);s.executor.release=release;
  let settled=0;const mutate=s.client.mutation.getMockImplementation()!;
  s.client.mutation.mockImplementation(async(ref:never,args:Record<string,unknown>)=>{const name=getFunctionName(ref);if(name==="compute:releasing")return;if(name==="compute:released"){expect(args["stoppedAt"]).toBe(1234);settled++;return;}return mutate(ref,args);});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({storageId:"blob"}))));
  vi.mocked(s.executor.inspect).mockResolvedValueOnce({state:"running",log:""});s.job.state="running";
  await s.run();expect(release).not.toHaveBeenCalled();expect(settled).toBe(0);
  release.mockRejectedValueOnce(new Error("Modal is down"));
  await expect(s.run()).rejects.toThrow("Modal is down");expect(s.job.state).toBe("succeeded");expect(settled).toBe(0);
  // The finished job comes back while its machine is unconfirmed; only the release is retried.
  await s.run();expect(release).toHaveBeenCalledTimes(2);expect(settled).toBe(1);expect(s.executor.inspect).toHaveBeenCalledTimes(2);
});
it("leaves a job as it is when the provider does not answer, instead of failing it",async()=>{
  const s=setup();s.job.state="running";
  vi.mocked(s.executor.inspect).mockRejectedValueOnce(new ExecutorUnavailable("Modal did not answer: socket hang up"));
  await expect(s.run()).rejects.toThrow("socket hang up");expect(s.job.state).toBe("running");
  vi.mocked(s.executor.readOutput).mockRejectedValueOnce(new ExecutorUnavailable("Modal did not answer: 503"));
  await expect(s.run()).rejects.toThrow("503");expect(s.job.state).toBe("publishing");
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({storageId:"blob"}))));
  await s.run();expect(s.job.state).toBe("succeeded");
});
it("resumes publishing from the recorded success, without asking the machine again",async()=>{
  const s=setup();s.job.state="publishing";(s.job as {exitCode?:number}).exitCode=0;
  vi.mocked(s.executor.inspect).mockResolvedValue({state:"failed",log:"",error:"The cloud machine stopped",exitCode:null});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({storageId:"blob"}))));
  await s.run();
  expect(s.executor.inspect).not.toHaveBeenCalled();expect(s.job.state).toBe("succeeded");
});
it("publishes each environment result as it is read, and retries a failed upload rather than failing the job",async()=>{
  const s=setup();
  s.job.spec={version:1,kind:"environment",title:"Env",environment:{name:"fea",image:"ghcr.io/x/y@sha256:"+"a".repeat(64)},command:"true",inputs:[],machine:"local",timeoutSeconds:60};
  const manifest={version:1,series:[{name:"s",label:"s",data:"series/s.json",points:1,x:{label:"x"},y:{lines:["a"]}}]};
  const files:Record<string,string>={"beam/out/manifest.json":JSON.stringify(manifest),"beam/out/series/s.json":JSON.stringify({x:[1],lines:[{name:"a",values:[2]}]})};
  const order:string[]=[];
  vi.mocked(s.executor.readOutput).mockImplementation(async(_h,path)=>{order.push(`read ${path}`);return new TextEncoder().encode(files[path]!);});
  const mutate=s.client.mutation.getMockImplementation()!;
  s.client.mutation.mockImplementation(async(ref:never,args:Record<string,unknown>)=>{const name=getFunctionName(ref);if(name==="compute:publishOutput"){order.push(`publish ${args["path"]}`);return;}if(name==="compute:publishResults")return;return mutate(ref,args);});
  s.client.query.mockImplementation(async(ref:never)=>{const name=getFunctionName(ref);if(name==="compute:pending")return [s.job];if(name==="compute:hasOutput")return false;throw new Error(name);});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({storageId:"blob"}))).mockRejectedValueOnce(new Error("offline")));
  await expect(s.run()).rejects.toThrow("offline");expect(s.job.state).toBe("publishing");
  order.length=0;await s.run();
  expect(order).toEqual(["read beam/out/manifest.json","publish beam/out/manifest.json","read beam/out/series/s.json","publish beam/out/series/s.json"]);
  expect(s.job.state).toBe("succeeded");
});
