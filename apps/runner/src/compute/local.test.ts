import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionHandle, ExecutionStatus, ProcessJobSpec } from "@beam/contracts";
import { LocalExecutor, readJobFile } from "./local.ts";

const roots: string[] = [];
const active: { executor: LocalExecutor; handle: ExecutionHandle }[] = [];
afterEach(async () => {
  for (const {executor,handle} of active.splice(0)) { try { await executor.cancel(handle); await finish(executor,handle); } catch {} }
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});
async function setup() { const root=await mkdtemp(join(tmpdir(),"beam-compute-test-"));roots.push(root);return new LocalExecutor(root); }
function spec(script: string, extra: Partial<ProcessJobSpec> = {}): ProcessJobSpec { return {version:1,kind:"process",title:"Test",executable:process.execPath,args:["-e",script],inputs:[],outputs:[],timeoutSeconds:10,...extra}; }
async function finish(executor:LocalExecutor,handle:ExecutionHandle):Promise<ExecutionStatus> {
  const until=Date.now()+8000;
  while(Date.now()<until){const result=await executor.inspect(handle);if(result.state!=="running")return result;await new Promise(r=>setTimeout(r,50));}
  throw new Error("Job did not finish");
}

describe("local compute executor",()=>{
  it("survives the submitting process exiting and recovers by handle without replaying",async()=>{
    const executor=await setup();
    const job=spec("setTimeout(()=>{require('fs').appendFileSync('result.txt','once');console.log('finished')},600)",{outputs:["result.txt"]});
    const module=fileURLToPath(new URL("./local.ts",import.meta.url));
    const driver=`import {LocalExecutor} from ${JSON.stringify(module)};const e=new LocalExecutor(${JSON.stringify(executor.home)});console.log(JSON.stringify(await e.submit('persistent',${JSON.stringify(job)},[])));`;
    const {stdout}=await promisify(execFile)(process.execPath,["--experimental-strip-types","--input-type=module","-e",driver]);
    const handle=JSON.parse(stdout.trim()) as ExecutionHandle;active.push({executor,handle});
    const reconnected=new LocalExecutor(executor.home);
    expect(await reconnected.submit("persistent",job,[])).toEqual(handle);
    expect(await finish(reconnected,handle)).toMatchObject({state:"succeeded",exitCode:0,log:"finished\n"});
    expect(Buffer.from(await reconnected.readOutput(handle,"result.txt")).toString()).toBe("once");
  });
  it("checks input hashes and runs against the snapshot in its own directory",async()=>{
    const executor=await setup(),bytes=Buffer.from("snapshot");
    const job=spec("require('fs').writeFileSync('out.txt',require('fs').readFileSync('input.txt'))",{inputs:[{assetId:"asset",path:"input.txt"}],outputs:["out.txt"]});
    const input={path:"input.txt",url:`data:application/octet-stream;base64,${bytes.toString('base64')}`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    const handle=await executor.submit("snapshot",job,[input]);active.push({executor,handle});
    expect(await finish(executor,handle)).toMatchObject({state:"succeeded"});
    expect(Buffer.from(await executor.readOutput(handle,"out.txt")).toString()).toBe("snapshot");
    const bad=await executor.submit("bad-hash",job,[{...input,sha256:"invalid"}]);
    expect(await finish(executor,bad)).toMatchObject({state:"failed",error:"Input snapshot checksum mismatch"});
  });
  it("cancels an independent process and enforces its runtime limit",async()=>{
    const executor=await setup();
    const handle=await executor.submit("cancel",spec("setInterval(()=>console.log('working'),100)"),[]);active.push({executor,handle});
    await executor.cancel(handle);
    expect(await finish(executor,handle)).toMatchObject({state:"cancelled"});
    await executor.cancelSubmission("cancel-before-launch");
    const racing=await executor.submit("cancel-before-launch",spec("process.exit(99)"),[]);active.push({executor,handle:racing});
    expect(await finish(executor,racing)).toMatchObject({state:"cancelled",exitCode:null});
    const limited=await executor.submit("timeout",spec("setInterval(()=>{},100)",{timeoutSeconds:1}),[]);active.push({executor,handle:limited});
    expect(await finish(executor,limited)).toMatchObject({state:"failed",error:"Runtime limit exceeded"});
  });
  it("reports failed exits and missing executables, and bounds output",async()=>{
    const executor=await setup();
    const handle=await executor.submit("failure",spec("console.log('x'.repeat(30000));process.exit(3)"),[]);active.push({executor,handle});
    const result=await finish(executor,handle);expect(result).toMatchObject({state:"failed",exitCode:3});expect(result.log.length).toBeLessThanOrEqual(16000);
    const missing=await executor.submit("missing",spec("",{executable:"/beam/nonexistent/executable"}),[]);active.push({executor,handle:missing});
    expect(await finish(executor,missing)).toMatchObject({state:"failed"});
  });
  it("rejects path traversal and symlink escapes when collecting results",async()=>{
    const executor=await setup();
    const root=await mkdtemp(join(tmpdir(),"beam-outside-"));roots.push(root);
    await writeFile(join(root,"secret"),"outside");await symlink(join(root,"secret"),join(executor.home,"link"));
    await expect(readJobFile(executor.home,"../secret")).rejects.toThrow();
    await expect(readJobFile(executor.home,"link")).rejects.toThrow("escapes");
  });
  it("does not relaunch an ambiguous or stale execution",async()=>{
    const executor=await setup();
    const handle=await executor.submit("stale",spec("process.exit(0)"),[]);active.push({executor,handle});await finish(executor,handle);
    await rm(join(executor.home,"stale","result.json"));
    await writeFile(join(executor.home,"stale","status.json"),JSON.stringify({heartbeatAt:0,log:"last output"}));
    expect(await executor.inspect(handle)).toMatchObject({state:"failed",log:"last output"});
    expect(await executor.submit("stale",spec("require('fs').writeFileSync('replayed','bad')"),[])).toEqual(handle);
    await expect(readFile(join(executor.home,"stale","work","replayed"))).rejects.toThrow();
  });
});
