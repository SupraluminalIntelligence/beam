import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { ComputeExecutor } from "@beam/contracts";
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
