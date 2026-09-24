import {useMutation,useQuery} from "convex/react";
import {useRef,useState} from "react";
import {api} from "../../../../convex/_generated/api";
import type {Id} from "../../../../convex/_generated/dataModel";
import {cadFormat} from "../cad/model";
import {ui,useUi} from "../lib/ui";
import {contextUploads,useContextUploads} from "../lib/contextUploads";
import {DocumentPreview,FilePreview,useAttachments} from "./Files";
import {SharedResources} from "./SharedResources";
import {toast} from "./Toast";

type SourceRow=NonNullable<ReturnType<typeof useQuery<typeof api.files.context>>>[number];
export function ContextPane({chatId}:{chatId:Id<"chats">}) {
  const panel=useUi().panels[chatId],scope=panel?.contextScope??"chat";
  const rows=useQuery(api.files.context,{chatId,scope});
  const uploads=useContextUploads().filter(u=>u.chatId===chatId);
  const [search,setSearch]=useState(""),[adding,setAdding]=useState(false);
  const close=()=>ui.panel(chatId,{selectedFile:null,selectedSource:null});
  if(panel?.selectedSource)return <SourcePreview key={panel.selectedSource} chatId={chatId} id={panel.selectedSource as Id<"contextSources">} close={close}/>;
  if(panel?.selectedFile)return <FilePreview key={panel.selectedFile} id={panel.selectedFile as Id<"files">} close={close} embedded/>;
  const shown=rows?.filter(row=>row.title.toLowerCase().includes(search.toLowerCase()));
  const open=(row:SourceRow)=>{if(row.kind==="file"&&cadFormat(row.title)){ui.openCad(chatId,row.sourceId?{kind:"source",id:row.sourceId}:{kind:"file",id:row.fileId!});return;}if(row.sourceId)ui.panel(chatId,{selectedSource:row.sourceId,selectedFile:null});else if(row.fileId)ui.panel(chatId,{selectedFile:row.fileId,selectedSource:null});};
  return <div className="workspace-scroll context-pane">
    <div className="context-heading"><div><h2>Context</h2><p>Files, links, and sources for your work.</p></div><button className="context-add" onClick={()=>setAdding(!adding)}>{adding?"Done":"＋ Add"}</button></div>
    <div className="context-scopes" role="group" aria-label="Context scope">{([['chat','This chat'],['workspace','Workspace']] as const).map(([id,label])=><button key={id} aria-pressed={scope===id} onClick={()=>{ui.panel(chatId,{contextScope:id});setSearch("");}}>{label}</button>)}</div>
    <p className="context-help">{scope==="chat"?"Sources here are available to this chat’s agents. Draft files are included after you send them.":"Shared workspace sources. Choose what to add to this chat."}</p>
    {scope==="workspace"&&<SharedResources chatId={chatId}/>}
    {adding&&<AddContext chatId={chatId} done={()=>setAdding(false)}/>}
    <input className="workspace-search" aria-label="Search context" placeholder="Find a source…" value={search} onChange={e=>setSearch(e.target.value)}/>
    {scope==="chat"&&uploads.map(upload=><div className="context-upload" key={upload.id} role="status"><span>{upload.error?"!":"◌"}</span><div><b>{upload.name}</b><small>{upload.status}</small></div>{upload.error&&<button aria-label={`Dismiss failed upload ${upload.name}`} onClick={()=>contextUploads.remove(upload.id)}>×</button>}</div>)}
    <div className="context-list">{shown?.map(row=><ContextRow key={row.key} row={row} chatId={chatId} scope={scope} open={()=>open(row)}/>)}</div>
    {rows===undefined&&<p className="context-help">Loading sources…</p>}
    {shown?.length===0&&<div className="workspace-empty"><b>{search?"No matching sources":scope==="workspace"?"No workspace sources yet":"Bring context into this chat"}</b><p>{search?"Try a different name.":scope==="workspace"?"Share a source from This chat to make it available here.":"Attach a document, add a link, or write a note. They’ll appear here beside the conversation."}</p></div>}
  </div>;
}
function ContextRow({row,chatId,scope,open}:{row:SourceRow;chatId:Id<"chats">;scope:"chat"|"workspace";open:()=>void}) {
  const include=useMutation(api.files.includeSource),shareFile=useMutation(api.files.shareFile),shareSource=useMutation(api.files.shareSource),remove=useMutation(api.files.removeSource),discard=useMutation(api.files.discard);
  const [busy,setBusy]=useState(false),[sharing,setSharing]=useState(false);
  async function action(fn:()=>Promise<unknown>){setBusy(true);try{await fn();setSharing(false);}catch(e){toast((e as Error).message);}finally{setBusy(false);}}
  return <div className="context-row"><div className="context-row-main"><button className="context-source" onClick={open}><span className="context-kind">{row.kind==="file"?"▤":row.kind==="link"?"↗":"≡"}</span><span><b>{row.title}</b><small>{row.kind}{row.size!==null?` · ${Math.ceil(row.size/1024)} KB`:""} · {row.draft?"Draft · only you":row.shared?"Shared with workspace":"This chat only"}</small></span></button>
    {scope==="workspace"?<button className="context-action" disabled={busy||row.included} onClick={()=>void action(()=>include({chatId,id:row.sourceId!}))}>{row.included?"Added ✓":"Add to this chat"}</button>:row.draft?<button className="context-action" disabled={busy} aria-label={`Remove draft ${row.title}`} onClick={()=>void action(()=>discard({id:row.fileId!}))}>Remove</button>:!row.shared?<button className="context-action" disabled={busy} onClick={()=>setSharing(!sharing)}>Share…</button>:row.sourceId&&row.key.startsWith("source:")?<button className="context-action" disabled={busy} onClick={()=>void action(()=>remove({chatId,id:row.sourceId!}))}>Remove</button>:null}
    {scope==="chat"&&row.sourceId&&!row.shared&&!row.draft&&<button className="context-action" disabled={busy} aria-label={`Remove ${row.title} from context`} onClick={()=>void action(()=>remove({chatId,id:row.sourceId!}))}>×</button>}
    </div>{sharing&&<div className="context-share"><p>Everyone in this workspace will be able to view <b>{row.title}</b> and add it to their chats.</p><button disabled={busy} onClick={()=>void action(()=>row.kind==="file"?shareFile({chatId,fileId:row.fileId!}):shareSource({chatId,id:row.sourceId!}))}>Share with workspace</button><button disabled={busy} onClick={()=>setSharing(false)}>Cancel</button></div>}
  </div>;
}
function AddContext({chatId,done}:{chatId:Id<"chats">;done:()=>void}) {
  const attachment=useAttachments(chatId),add=useMutation(api.files.addSource);
  const [kind,setKind]=useState<"link"|"note">("link"),[title,setTitle]=useState(""),[value,setValue]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const lock=useRef(false);
  async function submit(){if(lock.current)return;lock.current=true;setBusy(true);setError("");try{await add({chatId,kind,title,value});ui.openContext(chatId);done();}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
  return <div className="context-add-form"><div className="context-attach">{attachment.controls}<small>Files stay in your draft until you send.</small></div><form onSubmit={e=>{e.preventDefault();void submit();}}><fieldset disabled={busy}><label>Source type<select value={kind} onChange={e=>setKind(e.target.value as "link"|"note")}><option value="link">Link</option><option value="note">Note</option></select></label><label>Title<input required maxLength={255} value={title} onChange={e=>setTitle(e.target.value)} placeholder="What is this source?"/></label><label>{kind==="link"?"URL":"Note"}{kind==="link"?<input type="url" required maxLength={8192} value={value} onChange={e=>setValue(e.target.value)} placeholder="https://…"/>:<textarea required maxLength={20000} rows={4} value={value} onChange={e=>setValue(e.target.value)}/>}</label><p className="context-help">{kind==="link"?"The URL is added as a reference; page contents aren’t imported automatically.":"Added to this chat’s context for subsequent agent turns."}</p>{error&&<p className="compute-error" role="alert">{error}</p>}<button type="submit" className="context-add">{busy?"Adding…":"Add to this chat"}</button></fieldset></form></div>;
}
function SourcePreview({id,chatId,close}:{id:Id<"contextSources">;chatId:Id<"chats">;close:()=>void}) {
  const source=useQuery(api.files.sourcePreview,{chatId,id});
  if(source?.kind==="file")return <DocumentPreview file={source.file} close={close}/>;
  return <div className="workspace-scroll context-preview"><button className="context-action" onClick={close}>← Context</button><h2>{source?.title??"Loading source…"}</h2>{source?.kind==="link"?<><p className="context-help">Link reference · page contents aren’t stored in Beam.</p><a href={source.url!} target="_blank" rel="noreferrer">{source.url}</a></>:<pre>{source?.content}</pre>}</div>;
}
