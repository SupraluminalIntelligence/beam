import {beforeEach,expect,it,vi} from "vitest";
const auth=vi.hoisted(()=>({id:"alice"}));
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>auth.id}));
vi.mock("./runs",()=>({ownRun:async(ctx:any,token:string,id:string)=>{if(token!=="token")throw new Error("Invalid token");return {run:await ctx.db.get(id)};}}));
import {context,shareFile,shareSource,includeSource,removeSource,sourcePreview,addSource,contextForRun,forRun,preview} from "./files";
const call=(fn:any,ctx:any,args:any)=>fn._handler(ctx,args);
beforeEach(()=>{auth.id="alice";});
function fixture(){
 const tables:Record<string,any[]>={users:[{_id:"alice",githubLogin:"alice"},{_id:"bob",githubLogin:"bob"}],members:[{workspaceId:"ws",githubLogin:"alice"},{workspaceId:"ws",githubLogin:"bob"}],chats:[{_id:"private",workspaceId:"ws",private:true,members:["alice"]},{_id:"target",workspaceId:"ws",private:false,members:["alice","bob"]},{_id:"foreign",workspaceId:"elsewhere",private:false,members:["alice"]}],files:[{_id:"file",chatId:"private",storageId:"blob",name:"private.txt",mime:"text/plain",size:4,text:"data",author:"alice",messageId:"message",source:"uploaded"},{_id:"draft",chatId:"target",storageId:"draftblob",name:"draft.txt",mime:"text/plain",size:4,author:"bob",messageId:null}],contextSources:[],chatContext:[],runs:[{_id:"run",chatId:"target",dispatchedBy:"bob"}]};
 const db:any={get:async(id:string)=>Object.values(tables).flat().find(row=>row._id===id)??null,query:(t:string)=>{const filters:[string,unknown][]=[];const rows=()=>tables[t]!.filter(row=>filters.every(([key,value])=>row[key]===value));const chain:any={withIndex:(_:string,fn:any)=>{const q={eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;}};fn(q);return chain;},collect:async()=>rows(),first:async()=>rows()[0]??null};return chain;},insert:async(t:string,row:any)=>{const id=`${t}-${tables[t]!.length}`;tables[t]!.push({_id:id,...row});return id;},patch:async(id:string,row:any)=>Object.assign(await db.get(id),row),delete:async(id:string)=>{for(const t in tables)tables[t]=tables[t]!.filter(row=>row._id!==id);}};
 const ctx:any={db,storage:{getUrl:vi.fn(async()=>"https://blob.test/download")},scheduler:{runAfter:vi.fn()}};
 return {ctx,tables};
}
it("does not expose private files or another person's drafts in context",async()=>{
 const {ctx}=fixture();expect(await call(context,ctx,{chatId:"target",scope:"chat"})).toEqual([]);
 expect(await call(context,ctx,{chatId:"target",scope:"workspace"})).toEqual([]);
 auth.id="bob";await expect(call(context,ctx,{chatId:"private",scope:"chat"})).rejects.toThrow("private chat");
 expect((await call(context,ctx,{chatId:"target",scope:"chat"}))[0]).toMatchObject({draft:true,included:false,title:"draft.txt"});
 await expect(call(shareFile,ctx,{chatId:"target",fileId:"draft"})).rejects.toThrow("Send this file");
});
it("explicit sharing exposes only the file, without granting access to the private chat",async()=>{
 const {ctx}=fixture();const id=await call(shareFile,ctx,{chatId:"private",fileId:"file"});auth.id="bob";
 const rows=await call(context,ctx,{chatId:"target",scope:"workspace"});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({title:"private.txt",included:false,shared:true});expect(rows[0].originChatId).toBeUndefined();
 expect((await call(sourcePreview,ctx,{chatId:"target",id})).file.text).toBe("data");
 await expect(call(preview,ctx,{id:"file"})).rejects.toThrow("private chat");
});
it("reuses original storage and does not give agents access until the source is included",async()=>{
 const {ctx,tables}=fixture();const id=await call(shareFile,ctx,{chatId:"private",fileId:"file"});auth.id="bob";
 expect(await call(forRun,ctx,{token:"token",runId:"run"})).toEqual([]);
 await call(includeSource,ctx,{chatId:"target",id});await call(includeSource,ctx,{chatId:"target",id});
 expect(tables.chatContext).toHaveLength(1);expect(tables.files).toHaveLength(2);
 const available=await call(forRun,ctx,{token:"token",runId:"run",messageId:"other-message"});expect(available).toHaveLength(1);expect(available[0]).toMatchObject({_id:"file",storageId:"blob"});
 await call(removeSource,ctx,{chatId:"target",id});expect(await call(forRun,ctx,{token:"token",runId:"run"})).toEqual([]);
 expect((await call(context,ctx,{chatId:"target",scope:"workspace"}))[0].included).toBe(false);
});
it("adds notes and links to this chat, sharing and including them separately",async()=>{
 const {ctx}=fixture();const id=await call(addSource,ctx,{chatId:"private",kind:"note",title:"Constraints",value:"Use SI units"});
 expect(await call(context,ctx,{chatId:"target",scope:"workspace"})).toEqual([]);
 await expect(call(sourcePreview,ctx,{chatId:"target",id})).rejects.toThrow("unavailable");
 await expect(call(includeSource,ctx,{chatId:"target",id})).rejects.toThrow("unavailable");
 await call(shareSource,ctx,{chatId:"private",id});await call(includeSource,ctx,{chatId:"target",id});
 const notes=await call(contextForRun,ctx,{token:"token",runId:"run"});expect(notes[0]).toMatchObject({title:"Constraints",content:"Use SI units",kind:"note"});
 const link=await call(addSource,ctx,{chatId:"target",kind:"link",title:"Reference",value:"https://example.com/reference"});
 expect(await call(sourcePreview,ctx,{chatId:"target",id:link})).toMatchObject({url:"https://example.com/reference",content:null});
});
it("rejects unsafe URLs, oversized notes, cross-workspace sources, and revoked members",async()=>{
 const {ctx,tables}=fixture();for(const value of ["javascript:alert(1)","file:///etc/passwd","https://user:pass@example.com"])await expect(call(addSource,ctx,{chatId:"target",kind:"link",title:"Bad",value})).rejects.toThrow();
 await expect(call(addSource,ctx,{chatId:"target",kind:"note",title:"Big",value:"x".repeat(20001)})).rejects.toThrow();
 const id=await call(shareFile,ctx,{chatId:"private",fileId:"file"});tables.members!.push({workspaceId:"elsewhere",githubLogin:"alice"});
 await expect(call(includeSource,ctx,{chatId:"foreign",id})).rejects.toThrow("unavailable");
 tables.members=[];await expect(call(sourcePreview,ctx,{chatId:"target",id})).rejects.toThrow("not a member");
 await expect(call(contextForRun,ctx,{token:"token",runId:"run"})).rejects.toThrow("revoked");
});
