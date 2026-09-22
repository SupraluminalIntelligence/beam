import {useSyncExternalStore} from "react";
export interface ContextUpload {id:string;chatId:string;name:string;status:string;error:boolean}
let uploads:ContextUpload[]=[];
const listeners=new Set<()=>void>();
const publish=(next:ContextUpload[])=>{uploads=next;listeners.forEach(f=>f());};
export const contextUploads={
  isUploading:(chatId:string)=>uploads.some(u=>u.chatId===chatId&&!u.error),
  add:(chatId:string,names:string[])=>{const rows=names.map(name=>({id:crypto.randomUUID(),chatId,name,status:"Waiting to upload…",error:false}));publish([...uploads,...rows]);return rows;},
  update:(id:string,status:string,error=false)=>publish(uploads.map(u=>u.id===id?{...u,status,error}:u)),
  remove:(id:string)=>publish(uploads.filter(u=>u.id!==id)),
};
export const useContextUploads=()=>useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>uploads);
