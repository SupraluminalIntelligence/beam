import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeStl } from "@beam/contracts";
import { computeTools } from "./tools.ts";

// A cube missing its top: readable, but refused before anything is uploaded.
const corners=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].flat();
const open=encodeStl({points:corners,triangles:[[0,3,2,1],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].flatMap(([a,b,c,d])=>[a!,b!,c!,a!,c!,d!])});
it("imports models from the thread directory or a downloaded attachment, and nowhere else",async()=>{
 const thread=await mkdtemp(join(tmpdir(),"beam-thread-")),attachments=await mkdtemp(join(tmpdir(),"beam-attachments-")),other=await mkdtemp(join(tmpdir(),"beam-other-"));
 const client={mutation:vi.fn(),query:vi.fn()};
 const tool=(mode="auto")=>computeTools(client as never,"token","run" as never,thread,mode).find(t=>t.name==="import_simulation_model")!;
 try{
  for(const dir of [thread,attachments,other])await writeFile(join(dir,"part.stl"),open);
  await expect(tool().run({path:"part.stl"})).rejects.toThrow(/not closed: 4 edges/);
  await expect(tool().run({path:join(attachments,"part.stl")})).rejects.toThrow(/not closed/);
  await expect(tool().run({path:join(other,"part.stl")})).rejects.toThrow(/working directory/);
  await expect(tool().run({path:"../x.stl"})).rejects.toThrow();
  await expect(tool("plan").run({path:"part.stl"})).rejects.toThrow(/Plan mode/);
  expect(client.mutation).not.toHaveBeenCalled();
 }finally{await Promise.all([thread,attachments,other].map(d=>rm(d,{recursive:true,force:true})));}
});
