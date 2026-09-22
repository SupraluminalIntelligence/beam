import { it, expect, vi } from "vitest";
vi.mock("@convex-dev/auth/server",()=>({getAuthUserId:async()=>"u1"}));
import { list, preview, discard, finish } from "./files";
import { send } from "./messages";
function fixture() {
 const tables:Record<string,any[]>={users:[{_id:"u1",githubLogin:"apek"}],chats:[{_id:"chat",workspaceId:"ws",private:false,untitled:false,members:["apek"],autoRoute:false}],members:[{workspaceId:"ws",githubLogin:"apek"}],files:[{_id:"f",chatId:"chat",author:"apek",messageId:null,storageId:"blob",name:"test.txt",size:4,mime:"text/plain",source:"uploaded"}],agents:[],runs:[],messages:[],chatFollowers:[]};
 const db:any={get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,query:(t:string)=>({withIndex:(_:string,fn:any)=>{const filters:any[]=[];const q={eq:(k:string,v:any)=>{filters.push([k,v]);return q;}};fn(q);const rows=()=>tables[t]!.filter(r=>filters.every(([k,v])=>r[k]===v));return {collect:async()=>rows(),first:async()=>rows()[0]??null};}}),insert:async(t:string,value:any)=>{const id=`${t}${tables[t]!.length}`;tables[t]!.push({_id:id,...value});return id;},patch:async(id:string,p:any)=>Object.assign(await db.get(id),p),delete:async(id:string)=>{for(const t in tables)tables[t]=tables[t]!.filter(r=>r._id!==id);},system:{get:async()=>({size:4,contentType:"text/plain"})}};
 const ctx:any={db,storage:{getUrl:vi.fn(async()=>"https://example.test"),delete:vi.fn()},scheduler:{runAfter:vi.fn()}};
 return {ctx,tables};
}
const call=(f:any,ctx:any,args:any)=>f._handler(ctx,args);
it("keeps drafts out of the shared list and rejects unauthorized previews",async()=>{
 const {ctx,tables}=fixture();expect(await call(list,ctx,{chatId:"chat"})).toEqual([]);
 tables.files![0].author="george";await expect(call(preview,ctx,{id:"f"})).rejects.toThrow("Not your draft");
 tables.members=[];await expect(call(list,ctx,{chatId:"chat"})).rejects.toThrow("not a member");
});
it("enforces private chat membership and protects already-sent files",async()=>{
 const {ctx,tables}=fixture();tables.chats![0].private=true;tables.chats![0].members=["george"];
 await expect(call(preview,ctx,{id:"f"})).rejects.toThrow("private chat");
 tables.chats![0].members=["apek"];tables.files![0].messageId="m";
 await expect(call(discard,ctx,{id:"f"})).rejects.toThrow("Not your draft");expect(ctx.storage.delete).not.toHaveBeenCalled();
 await expect(call(finish,ctx,{chatId:"chat",storageId:"blob",name:"duplicate"})).rejects.toThrow("already attached");
});
it("sends attachment-only messages and rejects foreign, duplicate or already-sent attachments",async()=>{
 const {ctx,tables}=fixture();const args={chatId:"chat",text:"",mentionHandle:null,attachments:["f"]};
 tables.files![0].chatId="other";await expect(call(send,ctx,args)).rejects.toThrow("Invalid attachment");
 tables.files![0].chatId="chat";tables.files![0].author="george";await expect(call(send,ctx,args)).rejects.toThrow("Invalid attachment");
 tables.files![0].author="apek";await expect(call(send,ctx,{...args,attachments:["f","f"]})).rejects.toThrow("Maximum 10");
 const result=await call(send,ctx,args);expect(tables.files![0].messageId).toBe(result.id);
 expect(tables.messages![0].attachments).toEqual(["f"]);
 await expect(call(send,ctx,args)).rejects.toThrow("Invalid attachment");
});
