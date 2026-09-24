import {expect,it,vi} from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"user"}));
vi.mock("./runners",()=>({runnerForToken:async()=>({_id:"runner"})}));
import { detail } from "./runs";
it.each([null,{threadId:"old"}])("retains the original request when a prior session cannot be resumed (%j)",async(resumeCursor)=>{
 const execution={accountOwner:"alice",accountEmail:"a",model:"m",effort:"medium"};
 const rows:Record<string,any[]>={
 chats:[{_id:"chat",workspaceId:"ws",repos:[]}],agents:[{_id:"agent",workspaceId:"ws"}],changes:[],
 runs:[{_id:"prior",chatId:"chat",agentId:"agent",runnerId:"runner",dispatchedBy:"alice",execution,endedAt:20,resumeCursor},{_id:"run",chatId:"chat",agentId:"agent",runnerId:"runner",dispatchedBy:"alice",execution,dispatchMessageId:"retry"}],
 messages:[{_id:"original",chatId:"chat",_creationTime:10,kind:"text",text:"equilateral triangle"},{_id:"followup",chatId:"chat",_creationTime:25,kind:"text",text:"please retry"},{_id:"retry",chatId:"chat",_creationTime:30,kind:"text",text:"retry"},{_id:"future",chatId:"chat",_creationTime:40,kind:"text",text:"future"}],
 };
 const db={get:async(id:string)=>Object.values(rows).flat().find(r=>r._id===id),query:(table:string)=>{const filters:[string,unknown][]=[];const chain:any={withIndex:(_:string,f:any)=>{const q={eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;}};f(q);return chain;},collect:async()=>rows[table]!.filter(r=>filters.every(([k,v])=>r[k]===v))};return chain;}};
 const result=await (detail as any)._handler({db},{token:"token",runId:"run"});
 expect(result.transcript.map((m:any)=>m._id)).toEqual(resumeCursor?["followup"]:["original","followup"]);
 expect(result.recentTranscript.map((m:any)=>m._id)).toEqual(["original","followup"]);
});
