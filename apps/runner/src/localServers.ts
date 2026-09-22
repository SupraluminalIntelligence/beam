import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface LocalServer {url:string;port:number;processName:string}
// Adapted from T3 Code PortScanner.ts at 1de563c1 (MIT). See vendor/t3code/LICENSE.
export function parseListeners(raw:string):LocalServer[] {
  const ports=new Map<number,LocalServer>();let processName="Local server";
  for(const line of raw.split("\n")) {
    if(line.startsWith("p"))processName="Local server";
    else if(line.startsWith("c"))processName=line.slice(1).trim()||"Local server";
    else if(line.startsWith("n")) {
      const name=line.slice(1).split(" ")[0]??"",colon=name.lastIndexOf(":"),host=name.slice(0,colon),port=Number(name.slice(colon+1));
      if(!["*","localhost","127.0.0.1","0.0.0.0","[::]","[::1]"].includes(host)||!Number.isInteger(port)||port<1||port>65535)continue;
      ports.set(port,{url:`http://localhost:${port}`,port,processName});
    }
  }
  return [...ports.values()].sort((a,b)=>a.port-b.port);
}
export async function discoverLocalServers():Promise<LocalServer[]> {
  let candidates:LocalServer[];
  try { const {stdout}=await promisify(execFile)("lsof",["-iTCP","-sTCP:LISTEN","-P","-n","-F","pcn"],{timeout:5000,maxBuffer:1024*1024});candidates=parseListeners(stdout); }
  catch {candidates=[3000,3001,4173,4200,4321,5000,5173,5174,5500,8000,8080,8081,8888,9000].map(port=>({port,url:`http://localhost:${port}`,processName:"Local server"}));}
  const found:LocalServer[]=[];
  for(let i=0;i<Math.min(candidates.length,128);i+=16) {
    await Promise.all(candidates.slice(i,i+16).map(async server=>{
      try {const response=await fetch(server.url,{method:"HEAD",redirect:"manual",signal:AbortSignal.timeout(1000)});
        if(response.ok && /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type")??""))found.push(server);
        await response.body?.cancel();
      }catch{}
    }));
  }
  return found.sort((a,b)=>a.port-b.port);
}
