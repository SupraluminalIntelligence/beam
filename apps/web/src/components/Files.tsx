import { cadFormat } from "../cad/model";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { contextUploads } from "../lib/contextUploads";
import { ui } from "../lib/ui";
import { toast } from "./Toast";

const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
const isText = (name: string, mime: string) => mime.startsWith("text/") || /\.(txt|md|csv|json|xml|yaml|yml|log|ts|tsx|js|py|html|css|sh)$/i.test(name);
export function useAttachments(chatId: Id<"chats">) {
  const uploadUrl = useMutation(api.files.uploadUrl), finish = useMutation(api.files.finish), discard = useMutation(api.files.discard);
  const drafts = useQuery(api.files.drafts,{chatId}) ?? [];
  const [busy,setBusy] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  async function add(files: File[]) {
    if (lock.current || contextUploads.isUploading(chatId)) { toast("Wait for the current upload to finish"); return; }
    if (files.length + drafts.length > 10) { toast("Attach up to 10 files per message"); return; }
    if (!files.length) return;
    ui.openContext(chatId);
    const uploads = contextUploads.add(chatId, files.map(f=>f.name));
    lock.current = true; setBusy(true);
    try { for (const [index,file] of files.entries()) {
      const upload=uploads[index]!;
      try {
        contextUploads.update(upload.id,"Preparing preview…");
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: maximum file size is 20 MB`);
        let text: string | undefined;
        if (/\.docx$/i.test(file.name)) {
          try { const mammoth = await import("mammoth"); text = (await mammoth.extractRawText({arrayBuffer: await file.arrayBuffer()})).value.slice(0,200_000); }
          catch { toast(`${file.name}: text preview unavailable; attaching original`); }
        } else if (isText(file.name,file.type)) text = (await file.slice(0,800_000).text()).slice(0,200_000);
        contextUploads.update(upload.id,"Uploading…");
        const url = await uploadUrl({chatId});
        const response = await fetch(url,{method:"POST",headers:{"Content-Type":file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : /\.docx$/i.test(file.name) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : isText(file.name, "") ? "text/plain" : "application/octet-stream")},body:file});
        if (!response.ok) throw new Error(`Upload failed for ${file.name}`);
        const {storageId} = await response.json();
        await finish({chatId,storageId,name:file.name,...(text === undefined ? {} : {text})});
        contextUploads.remove(upload.id);
      } catch(e) { contextUploads.update(upload.id,(e as Error).message,true); toast((e as Error).message); }
    }} finally {lock.current=false;setBusy(false);}
  }
  async function paste(e: React.ClipboardEvent, insertText: (text:string)=>void) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void add(files); return; }
    // Ordinary text keeps the browser's native paste behavior.
    if (bridge()?.clipboardFiles) {
      const plain = e.clipboardData.getData("text/plain");
      e.preventDefault();
      try { const copied = await bridge()!.clipboardFiles!(); if (!copied.length) { insertText(plain); return; } await add(copied.map(f => new File([Uint8Array.from(atob(f.base64), c=>c.charCodeAt(0))],f.name))); }
      catch(e) {toast((e as Error).message);}
    }
  }
  const remove = (id: Id<"files">) => { void discard({id}).catch(e=>toast(e.message)); };
  const controls = <><input ref={input} type="file" multiple hidden onChange={e=>{void add(Array.from(e.target.files ?? []));e.target.value="";}} /><button disabled={busy} onClick={()=>input.current?.click()} title="Attach files">＋ Attach</button></>;
  const chips = <div className="file-drafts">{drafts.map(f=><DraftFile key={f.id} chatId={chatId} id={f.id} name={f.name} remove={()=>remove(f.id)} />)}{busy && <span role="status">Uploading…</span>}</div>;
  return {drafts,busy,add,paste,controls,chips,clear:()=>{}};
}

export function DraftFile({id,name,remove,chatId}:{chatId:Id<"chats">;id:Id<"files">;name:string;remove:()=>void}) {
  const file=useQuery(api.files.preview,{id});
  return <><div className="draft-document">
    <button className="draft-document-open" onClick={()=>ui.openFile(chatId,id,name)} aria-label={`Preview ${name}`} title={name}>
      <div className="draft-document-thumbnail" aria-hidden="true">
        {file?.text !== undefined ? <div className="draft-document-page">{file.text.slice(0,1400) || "No text found"}</div>
          : file?.url && /\.(png|jpe?g|gif|webp)$/i.test(name) ? <img src={file.url} alt="" />
          : file?.url && file.mime === "application/pdf" ? <iframe tabIndex={-1} title={`${name} thumbnail`} src={`${file.url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`} />
          : <span className="draft-document-placeholder">{file ? "Preview document" : "Loading preview…"}</span>}
      </div>
      <span className="draft-document-caption"><svg viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M3 1h8l5 5v14H3zM11 1v6h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg><b>{name}</b></span>
    </button>
    <button className="draft-document-remove" onClick={remove} aria-label={`Remove ${name}`}>×</button>
  </div></>;
}

type FileRow = NonNullable<ReturnType<typeof useQuery<typeof api.files.list>>>[number];
function FileCard({file,onClick}:{file:FileRow;onClick:()=>void}) {return <button className="file-card" onClick={onClick}><span>{cadFormat(file.name)?"◇":"▤"}</span><span><b>{file.name}</b><small>{file.name.split('.').pop()?.toUpperCase()} · {size(file.size)}{cadFormat(file.name)?" · Open in CAD Viewer":""}</small></span></button>;}
export function MessageFiles({ids,chatId}:{ids:Id<"files">[];chatId:Id<"chats">}) {
  const files=useQuery(api.files.list,{chatId});
  return <div className="message-files">{files?.filter(f=>ids.includes(f._id)).map(f=><FileCard key={f._id} file={f} onClick={()=>ui.openFile(chatId,f._id,f.name)} />)}</div>;
}
export function FilePreview({id,close,embedded=false}:{id:Id<"files">;close:()=>void;embedded?:boolean}) {
  const file=useQuery(api.files.preview,{id});
  return <DocumentPreview file={file} close={close} embedded={embedded} />;
}
export function DocumentPreview({file,close,embedded=true}:{file:{name:string;mime:string;text?:string|undefined;url:string|null}|null|undefined;close:()=>void;embedded?:boolean}) {
  const [extracted,setExtracted]=useState<string|null>(null);
  useEffect(()=>{
    let cancelled=false; setExtracted(null);
    if (file?.url && file.text === undefined && /\.docx$/i.test(file.name)) {
      void (async()=>{const response=await fetch(file.url!);if(!response.ok)throw new Error("Download failed");const mammoth=await import("mammoth");const result=await mammoth.extractRawText({arrayBuffer:await response.arrayBuffer()});if(!cancelled)setExtracted(result.value.slice(0,200_000));})().catch(()=>{if(!cancelled)setExtracted("Could not extract a preview. Download the original to open it.");});
    }
    return ()=>{cancelled=true;};
  },[file?.url,file?.text,file?.name]);
  const previewText=file?.text ?? extracted;
  return <div className={embedded ? "file-preview-embedded" : "file-preview-backdrop"} onClick={embedded ? undefined : close}><section className="file-preview" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={file?.name ?? "File preview"} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape")close();}}><div className="file-heading"><b title={file?.name}>{file?.name ?? "Loading…"}</b>{file?.url && <a href={file.url} target="_blank" rel="noreferrer" download={file.name}>Download original</a>}<button autoFocus onClick={close} aria-label={embedded ? "Back to context" : "Close preview"}>{embedded ? "← Context" : "×"}</button></div>{file && (/\.pdf$/i.test(file.name) && file.mime === "application/pdf" && file.url ? <iframe title={file.name} src={file.url} /> : previewText !== null && previewText !== undefined ? <pre>{previewText || "No text found in this document."}{previewText.length === 200_000 ? "\n\nPreview truncated. Download the original for the full document." : ""}</pre> : /\.(png|jpe?g|gif|webp)$/i.test(file.name) && file.url ? <img src={file.url} alt={file.name} /> : <p>Preview unavailable for this file type. Download the original to open it.</p>)}</section></div>;
}
