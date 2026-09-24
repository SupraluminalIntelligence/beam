import { expect,it,vi } from "vitest";
vi.mock("./runs",()=>({chooseRunner:async()=>({_id:"runner",name:"Local",ownerLogin:"alice",harnesses:[{harness:"claude",auth:"authenticated"}]}),isLive:()=>false}));
vi.mock("./notifications",()=>({followParticipant:async()=>{}}));
import { startRun } from "./messages";

it.each([
 [{id:"study-at-send",revision:3,name:"Wake"},"study-at-send"],
 [null,null],
 [undefined,"current-study"],
])("binds delayed agent dispatch to the message's study context (%j)",async(studyContext,expected)=>{
 const message:any={_id:"message",...(studyContext!==undefined?{studyContext}:{})};let inserted:any;
 const ctx:any={db:{get:async()=>message,query:()=>({withIndex:()=>({first:async()=>({agentPreferences:[]})})}),insert:async(_:string,value:any)=>{inserted=value;return"run";},patch:async()=>{}}};
 await startRun(ctx,{_id:"chat",activeStudyId:"current-study",activeBranch:null} as any,{_id:"agent",harness:"claude",model:"opus",effort:"high"} as any,"message" as any,"alice");
 expect(inserted.studyId).toBe(expected);
});
