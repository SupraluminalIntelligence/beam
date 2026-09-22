import { session, type WebContents } from "electron";

// T3 Code's guest-session pattern, adapted for Beam: guests never receive Beam's preload.
export const PREVIEW_PARTITION = "persist:beam-preview-v1";
export function previewUrlAllowed(value: string) {
  if(value==="about:blank")return true;
  try { const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password; } catch {return false;}
}
export function installPreviewHost(host:WebContents) {
  const preview=session.fromPartition(PREVIEW_PARTITION);
  preview.setPermissionRequestHandler((_contents,_permission,allow)=>allow(false));
  preview.setPermissionCheckHandler(()=>false);
  preview.on("will-download",event=>event.preventDefault());
  host.on("will-attach-webview",(event,preferences,params)=>{
    if(params.partition!==PREVIEW_PARTITION || !previewUrlAllowed(params.src??"")){event.preventDefault();return;}
    delete preferences.preload;
    preferences.nodeIntegration=false;
    preferences.nodeIntegrationInSubFrames=false;
    preferences.nodeIntegrationInWorker=false;
    preferences.contextIsolation=true;
    preferences.sandbox=true;
    preferences.webSecurity=true;
    preferences.allowRunningInsecureContent=false;
    preferences.webviewTag=false;
  });
  host.on("did-attach-webview",(_event,guest)=>{
    guest.setWindowOpenHandler(()=>({action:"deny"}));
    guest.on("will-navigate",(event,url)=>{if(!previewUrlAllowed(url))event.preventDefault();});
    guest.on("will-redirect",(event,url)=>{if(!previewUrlAllowed(url))event.preventDefault();});
  });
}
