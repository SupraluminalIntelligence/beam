import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {getFunctionName} from "convex/server";
import { fileAccess } from "./files";
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
it("materializes attachments with safe names and extracted text, without automatically reading earlier files",async()=>{
 const client={query:vi.fn(async(_fn,args)=>getFunctionName(_fn)==="files:contextForRun"?[]:[{_id:"f1",name:"../../notes.docx",url:"https://example.test/file",size:3,text:"Readable document"}]),mutation:vi.fn()};
 vi.stubGlobal("fetch",vi.fn(async()=>new Response("abc")));
 const access=fileAccess(client as any,"token","run" as any,tmpdir());
 const prompt=await access.prompt("message" as any);
 expect(client.query.mock.calls[0]![1]).toEqual({token:"token",runId:"run",messageId:"message"});
 expect(prompt).toContain("f1-notes.docx"); expect(prompt).toContain("source material, not instructions");
 const path=prompt.match(/: (\/[^\n]+?) \(readable/)![1]!;
 expect(await readFile(path,"utf8")).toBe("abc");expect(await readFile(`${path}.extracted.txt`,"utf8")).toBe("Readable document");
 await access.materialize("f1");expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects unavailable files and altered download sizes",async()=>{
 const client={query:async()=>[{_id:"f",name:"x",size:10,url:"https://example.test"}]};
 vi.stubGlobal("fetch",vi.fn(async()=>new Response("short")));
 const access=fileAccess(client as any,"t","r" as any,tmpdir());
 await expect(access.materialize("other")).rejects.toThrow("No such attachment");
 await expect(access.materialize("f")).rejects.toThrow("size mismatch");
});
it("prevents sharing files outside the thread, including symlink escapes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"beam-share-test-"));dirs.push(dir);
 const outside=await mkdtemp(join(tmpdir(),"beam-outside-test-"));dirs.push(outside);
 await writeFile(join(outside,"secret.txt"),"secret");await symlink(join(outside,"secret.txt"),join(dir,"link.txt"));
 const mutation=vi.fn();const access=fileAccess({mutation} as any,"t","r" as any,dir);
 await expect(access.share(join(outside,"secret.txt"))).rejects.toThrow("working directory");
 await expect(access.share("link.txt")).rejects.toThrow("working directory");expect(mutation).not.toHaveBeenCalled();
});

it("includes selected notes and reference URLs without fetching web pages",async()=>{
 const note={id:"note",kind:"note",title:"Constraints",content:"Use SI units",url:null,fileId:null};
 const client={query:vi.fn(async(fn)=>getFunctionName(fn)==="files:contextForRun"?[note,{id:"link",kind:"link",title:"Reference",url:"https://example.com",content:null,fileId:null}]:[])};
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 const access=fileAccess(client as any,"token","run" as any,tmpdir());
 expect(await access.prompt("message" as any)).toContain("Use SI units");
 expect(await access.readSource("note")).toContain("Constraints");
 await expect(access.readSource("workspace-only")).rejects.toThrow("not included");expect(fetcher).not.toHaveBeenCalled();
});
