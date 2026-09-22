import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ContextSourceInput } from "../packages/contracts/src/context";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireChat } from "./lib";
import { ownRun } from "./runs";

async function fileRun(ctx: QueryCtx | MutationCtx, token: string, runId: Id<"runs">) {
  const result = await ownRun(ctx, token, runId);
  const chat = await ctx.db.get(result.run.chatId);
  if (!chat || chat.state === "deleted" || (chat.private && !chat.members.includes(result.run.dispatchedBy))) throw new Error("Chat access revoked");
  const members = await ctx.db.query("members").withIndex("by_workspace", q=>q.eq("workspaceId",chat.workspaceId)).collect();
  if (!members.some(m=>m.githubLogin === result.run.dispatchedBy)) throw new Error("Chat access revoked");
  return result;
}
const MAX = 20 * 1024 * 1024;
const fields = { storageId: v.id("_storage"), name: v.string(), text: v.optional(v.string()) };
export const uploadUrl = mutation({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  await requireChat(ctx, chatId); return ctx.storage.generateUploadUrl();
} });
export const finish = mutation({ args: { chatId: v.id("chats"), ...fields }, handler: async (ctx, a) => {
  const { u } = await requireChat(ctx, a.chatId);
  if (await ctx.db.query("files").withIndex("by_storage", q=>q.eq("storageId",a.storageId)).first()) throw new Error("File already attached");
  const drafts=await ctx.db.query("files").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect();
  if(drafts.filter(f=>!f.messageId&&f.author===u.githubLogin).length>=10)throw new Error("Attach up to 10 files per message");
  const meta = await ctx.db.system.get(a.storageId);
  if (!meta || meta.size > MAX) throw new Error("Files must be 20 MB or smaller");
  if (!a.name.trim() || a.name.length > 255 || (a.text?.length ?? 0) > 200_000) throw new Error("Invalid file metadata");
  return ctx.db.insert("files", { chatId: a.chatId, storageId: a.storageId, name: a.name, size: meta.size, mime: meta.contentType ?? "application/octet-stream", author: u.githubLogin!, source: "uploaded", messageId: null, ...(a.text === undefined ? {} : {text:a.text}) });
} });
export const discard = mutation({ args: { id: v.id("files") }, handler: async (ctx, { id }) => {
  const f = await ctx.db.get(id); if (!f) return;
  const { u } = await requireChat(ctx, f.chatId);
  if (f.author !== u.githubLogin || f.messageId) throw new Error("Not your draft");
  await ctx.storage.delete(f.storageId); await ctx.db.delete(id);
} });
export const list = query({ args: { chatId: v.id("chats") }, handler: async (ctx, { chatId }) => {
  await requireChat(ctx, chatId);
  const files = await ctx.db.query("files").withIndex("by_chat", q => q.eq("chatId", chatId)).collect();
  return files.filter(f => f.messageId).map(({text, storageId, ...f}) => f);
} });
export const preview = query({ args: { id: v.id("files") }, handler: async (ctx, { id }) => {
  const f = await ctx.db.get(id); if (!f) return null;
  const { u } = await requireChat(ctx, f.chatId);
  if (!f.messageId && f.author !== u.githubLogin) throw new Error("Not your draft");
  return { ...f, url: await ctx.storage.getUrl(f.storageId) };
} });
export const forRun = query({ args: { token: v.string(), runId: v.id("runs"), messageId: v.optional(v.id("messages")) }, handler: async (ctx, a) => {
  const { run } = await fileRun(ctx, a.token, a.runId);
  const files = await ctx.db.query("files").withIndex("by_chat", q => q.eq("chatId", run.chatId)).collect();
  const linked = await selectedSources(ctx, run.chatId);
  const linkedFiles = await Promise.all(linked.filter(s=>s.fileId).map(s=>ctx.db.get(s.fileId!)));
  const available = new Map(files.filter(f => f.messageId && (!a.messageId || f.messageId === a.messageId)).map(f=>[f._id,f]));
  for(const file of linkedFiles)if(file?.messageId)available.set(file._id,file);
  return Promise.all([...available.values()].map(async f => ({ ...f, url: await ctx.storage.getUrl(f.storageId) })));
} });
export const runnerUploadUrl = mutation({ args: { token: v.string(), runId: v.id("runs") }, handler: async (ctx, a) => {
  await fileRun(ctx, a.token, a.runId); return ctx.storage.generateUploadUrl();
} });
export const share = mutation({ args: { token: v.string(), runId: v.id("runs"), ...fields }, handler: async (ctx, a) => {
  const {run} = await fileRun(ctx, a.token, a.runId);
  if (await ctx.db.query("files").withIndex("by_storage", q=>q.eq("storageId",a.storageId)).first()) throw new Error("File already attached");
  const meta = await ctx.db.system.get(a.storageId);
  if (!meta || meta.size > MAX || a.name.length > 255 || (a.text?.length ?? 0) > 200_000) throw new Error("Invalid file");
  const author = `agent:${run.agentId}`;
  const messageId = await ctx.db.insert("messages", { chatId: run.chatId, author, kind: "text", text: "", runId: run._id, reactions: [] });
  const id = await ctx.db.insert("files", {chatId:run.chatId, storageId:a.storageId, name:a.name, mime:meta.contentType ?? "application/octet-stream",size:meta.size,author,source:"agent",messageId,...(a.text === undefined ? {} : {text:a.text})});
  await ctx.db.patch(messageId,{attachments:[id]}); return id;
} });

// Unsent drafts and abandoned uploads expire after a day.
export const cleanup = internalMutation({args:{cursor:v.optional(v.string())},handler:async(ctx,{cursor})=>{
  const page = await ctx.db.system.query("_storage").paginate({numItems:100,cursor:cursor ?? null});
  const cutoff=Date.now()-24*60*60*1000;
  for (const blob of page.page) {
    if (blob._creationTime>cutoff) continue;
    if (await ctx.db.query("computeAssets").withIndex("by_storage",q=>q.eq("storageId",blob._id)).first()) continue;
    const file=await ctx.db.query("files").withIndex("by_storage",q=>q.eq("storageId",blob._id)).first();
    if (!file || !file.messageId) {await ctx.storage.delete(blob._id);if(file)await ctx.db.delete(file._id);}
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0,internal.files.cleanup,{cursor:page.continueCursor});
}});

export const drafts = query({args:{chatId:v.id("chats")},handler:async(ctx,{chatId})=>{
  const {u}=await requireChat(ctx,chatId);
  const files=await ctx.db.query("files").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect();
  return files.filter(f=>!f.messageId && f.author===u.githubLogin).map(f=>({id:f._id,name:f.name}));
}});

// Sources are stored once. Chat associations determine what an agent may use;
// workspace sharing determines what people can discover and explicitly include.
type Ctx = QueryCtx | MutationCtx;
async function selectedSources(ctx:Ctx,chatId:Id<"chats">) {
  const chat=await ctx.db.get(chatId);if(!chat||chat.state==="deleted")return [];
  const refs=await ctx.db.query("chatContext").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect();
  const sources=await Promise.all(refs.map(ref=>ctx.db.get(ref.sourceId)));
  return sources.filter((s):s is Doc<"contextSources">=>!!s&&s.workspaceId===chat.workspaceId&&(s.shared||s.originChatId===chatId));
}
async function sourceAccess(ctx:Ctx,chatId:Id<"chats">,id:Id<"contextSources">) {
  const access=await requireChat(ctx,chatId),source=await ctx.db.get(id);
  if(!source||source.workspaceId!==access.chat.workspaceId||(!source.shared&&source.originChatId!==chatId))throw new Error("Source unavailable in this chat");
  return {...access,source};
}
export const addSource=mutation({args:{chatId:v.id("chats"),kind:v.union(v.literal("link"),v.literal("note")),title:v.string(),value:v.string()},handler:async(ctx,a)=>{
  const {chat,u}=await requireChat(ctx,a.chatId),input=ContextSourceInput.parse(a);
  let url:string|undefined;
  if(input.kind==="link"){
    const parsed=new URL(input.value);
    if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||input.value.length>8192)throw new Error("Use an HTTP or HTTPS link without credentials");
    url=parsed.href;
  }
  await checkSourceLimit(ctx,a.chatId);
  const sourceId=await ctx.db.insert("contextSources",{workspaceId:chat.workspaceId,originChatId:a.chatId,author:u.githubLogin!,kind:input.kind,title:input.title,shared:false,...(url?{url}:{content:input.value})});
  await ctx.db.insert("chatContext",{chatId:a.chatId,sourceId,addedBy:u.githubLogin!});return sourceId;
}});
async function checkSourceLimit(ctx:Ctx,chatId:Id<"chats">){
  const refs=await ctx.db.query("chatContext").withIndex("by_chat",q=>q.eq("chatId",chatId)).collect();
  if(refs.length>=50)throw new Error("A chat can include up to 50 additional sources");
}
export const shareFile=mutation({args:{chatId:v.id("chats"),fileId:v.id("files")},handler:async(ctx,a)=>{
  const {chat,u}=await requireChat(ctx,a.chatId),file=await ctx.db.get(a.fileId);
  if(!file||file.chatId!==a.chatId||!file.messageId)throw new Error("Send this file before sharing it with the workspace");
  const existing=await ctx.db.query("contextSources").withIndex("by_file",q=>q.eq("fileId",a.fileId)).first();
  if(existing){await ctx.db.patch(existing._id,{shared:true});return existing._id;}
  return ctx.db.insert("contextSources",{workspaceId:chat.workspaceId,originChatId:a.chatId,author:u.githubLogin!,kind:"file",title:file.name,fileId:file._id,shared:true});
}});
export const shareSource=mutation({args:{chatId:v.id("chats"),id:v.id("contextSources")},handler:async(ctx,a)=>{
  const {source}=await sourceAccess(ctx,a.chatId,a.id);
  if(source.originChatId!==a.chatId)throw new Error("Share a source from its original chat");
  await ctx.db.patch(a.id,{shared:true});
}});
export const includeSource=mutation({args:{chatId:v.id("chats"),id:v.id("contextSources")},handler:async(ctx,a)=>{
  const {source,u}=await sourceAccess(ctx,a.chatId,a.id);
  if(!source.shared)throw new Error("Source is not shared with the workspace");
  if(source.fileId){const file=await ctx.db.get(source.fileId);if(!file?.messageId)throw new Error("File unavailable");if(file.chatId===a.chatId)return;}
  const existing=await ctx.db.query("chatContext").withIndex("by_chat_source",q=>q.eq("chatId",a.chatId).eq("sourceId",a.id)).first();
  if(existing)return;
  await checkSourceLimit(ctx,a.chatId);
  await ctx.db.insert("chatContext",{chatId:a.chatId,sourceId:a.id,addedBy:u.githubLogin!});
}});
export const removeSource=mutation({args:{chatId:v.id("chats"),id:v.id("contextSources")},handler:async(ctx,a)=>{
  await requireChat(ctx,a.chatId);
  const refs=await ctx.db.query("chatContext").withIndex("by_chat_source",q=>q.eq("chatId",a.chatId).eq("sourceId",a.id)).collect();
  for(const ref of refs)await ctx.db.delete(ref._id);
}});
export const context= query({args:{chatId:v.id("chats"),scope:v.union(v.literal("chat"),v.literal("workspace"))},handler:async(ctx,a)=>{
  const {chat,u}=await requireChat(ctx,a.chatId);
  const selected=await selectedSources(ctx,a.chatId),selectedIds=new Set(selected.map(s=>s._id));
  const shared=await ctx.db.query("contextSources").withIndex("by_workspace_shared",q=>q.eq("workspaceId",chat.workspaceId).eq("shared",true)).collect();
  const sourceRow=(s:Doc<"contextSources">)=>({key:`source:${s._id}`,sourceId:s._id,fileId:s.fileId??null,title:s.title,kind:s.kind,shared:s.shared,included:selectedIds.has(s._id),draft:false,author:s.author,size:null as number|null});
  if(a.scope==="workspace")return shared.map(s=>({...sourceRow(s),included:selectedIds.has(s._id)||(s.kind==="file"&&s.originChatId===a.chatId)}));
  const files=await ctx.db.query("files").withIndex("by_chat",q=>q.eq("chatId",a.chatId)).collect();
  const rows=files.filter(f=>f.messageId||f.author===u.githubLogin).map(f=>{
    const source=shared.find(s=>s.fileId===f._id);
    return {key:`file:${f._id}`,sourceId:source?._id??null,fileId:f._id,title:f.name,kind:"file" as const,shared:!!source,included:!!f.messageId,draft:!f.messageId,author:f.author,size:f.size};
  });
  return [...rows,...selected.filter(s=>!s.fileId||!files.some(f=>f._id===s.fileId)).map(sourceRow)];
}});
export const sourcePreview=query({args:{chatId:v.id("chats"),id:v.id("contextSources")},handler:async(ctx,a)=>{
  const {source}=await sourceAccess(ctx,a.chatId,a.id);
  const file=source.fileId?await ctx.db.get(source.fileId):null;
  return {title:source.title,kind:source.kind,url:source.url??null,content:source.content??null,file:file&&file.messageId?{name:file.name,mime:file.mime,text:file.text,url:await ctx.storage.getUrl(file.storageId)}:null};
}});
export const contextForRun=query({args:{token:v.string(),runId:v.id("runs")},handler:async(ctx,a)=>{
  const {run}=await fileRun(ctx,a.token,a.runId);
  return (await selectedSources(ctx,run.chatId)).map(s=>({id:s._id,kind:s.kind,title:s.title,url:s.url??null,content:s.content??null,fileId:s.fileId??null}));
}});
