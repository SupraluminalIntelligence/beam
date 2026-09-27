import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { decodeModel, normalizeModel, type Model3D, type Surface } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";

/** Normalized surfaces by asset id: kept after an import, and downloaded once for studies that name them. */
const surfaces=new Map<string,Promise<Surface>>();
export const MODEL_ACCEPT=".stl,.obj";

/** Parse, check and store a model file; the study keeps only the returned reference. */
export async function importModelFile(file:File,store:{uploadUrl:()=>Promise<string>;stage:(storageId:string)=>Promise<{assetId:string;sha256:string}>}):Promise<Model3D>{
 const {surface,measures:{shells:_,...measures},stl}=normalizeModel(new Uint8Array(await file.arrayBuffer()),file.name);
 const response=await fetch(await store.uploadUrl(),{method:"POST",headers:{"Content-Type":"model/stl"},body:new Blob([stl.buffer as ArrayBuffer])});
 if(!response.ok)throw new Error(`Model upload failed: ${response.status}`);
 const {storageId}=await response.json() as {storageId:string};
 const staged=await store.stage(storageId);
 surfaces.set(staged.assetId,Promise.resolve(surface));
 return{assetId:staged.assetId,file:file.name.slice(0,120),sha256:staged.sha256,...measures};
}
/** The stored surfaces a study's imported bodies name, as they become available. */
export function useModelSurfaces(assetIds:string[]){
 const key=[...new Set(assetIds)].sort().join(),missing=key?key.split(",").filter(id=>!surfaces.has(id)):[];
 const files=useQuery(api.compute.modelFiles,missing.length?{assetIds:missing}:"skip");
 const [loaded,setLoaded]=useState<Record<string,Surface>>({}),[error,setError]=useState("");
 useEffect(()=>{
  for(const f of files??[])if(!surfaces.has(f.assetId))surfaces.set(f.assetId,fetch(f.url).then(async r=>{if(!r.ok)throw new Error("Model download failed");return decodeModel(new Uint8Array(await r.arrayBuffer()));}).catch(e=>{surfaces.delete(f.assetId);throw e;}));
  let live=true;const ids=key?key.split(","):[];
  Promise.all(ids.filter(id=>surfaces.has(id)).map(async id=>[id,await surfaces.get(id)!] as const)).then(rows=>{if(live)setLoaded(Object.fromEntries(rows));},e=>{if(live)setError((e as Error).message);});
  return()=>{live=false;};
 },[key,files]);
 return{surfaces:loaded,error};
}
