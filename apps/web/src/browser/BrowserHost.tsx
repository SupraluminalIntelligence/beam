import { createElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { rememberBrowserUrl } from "./BrowserStart";
import { bridge } from "../bridge";
import { ui, useUi } from "../lib/ui";
import { INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, planWebviewCrashRecovery } from "../vendor/t3code/webviewCrashRecovery";
import { resolveHostedBrowserWebviewWrapperStyle, type BrowserSurfaceRect } from "../vendor/t3code/hostedBrowserWebviewStyle";

interface Guest extends HTMLElement {
  getURL():string; canGoBack():boolean; canGoForward():boolean;
  goBack():void; goForward():void; reload():void; stop():void; loadURL(url:string):Promise<void>;
}
type Status = {back:boolean;forward:boolean;loading:boolean;error:string};
const empty:Status={back:false,forward:false,loading:false,error:""};
const guests=new Map<string,Guest>();
const statuses=new Map<string,Status>();
const listeners=new Set<()=>void>();
const notify=()=>listeners.forEach(f=>f());
export function useBrowserStatus(chat:string) { return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>statuses.get(chat)??empty); }
export function browserAction(chat:string,action:"back"|"forward"|"reload"|"stop") {
  const guest=guests.get(chat);if(!guest)return;
  ui.panel(chat,{browserHome:false});
  try {if(action==="back")guest.goBack();else if(action==="forward")guest.goForward();else if(action==="reload")guest.reload();else guest.stop();} catch {}
}

/** Like T3's ElectronBrowserHost, lives outside the pane so hiding/switching tools retains sessions. */
export function BrowserHost({activeChat,obscured=false}:{activeChat:string|null;obscured?:boolean}) {
  const {panels}=useUi();
  return <>{Object.entries(panels).filter(([,p])=>p.tabs.includes("browser")&&p.browserUrl).map(([id,p])=><HostedBrowser key={id} chat={id} url={p.browserUrl!} active={!obscured&&activeChat===id&&p.open&&!p.browserHome&&p.active==="browser"} />)}</>;
}
function HostedBrowser({chat,url,active}:{chat:string;url:string;active:boolean}) {
  const native=!!bridge()?.browserPreview;
  const node=useRef<Guest|null>(null),latest=useRef(url),recovery=useRef(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  latest.current=url;
  const [initial]=useState(url),[generation,setGeneration]=useState(0),[rect,setRect]=useState<BrowserSurfaceRect|null>(null);
  useEffect(()=>{
    if(!active){setRect(null);return;}
    let frame=0;
    const measure=()=>{
      const anchor=document.querySelector(`[data-browser-surface="${CSS.escape(chat)}"]`);
      const bounds=anchor?.getBoundingClientRect();
      const next=bounds&&bounds.width>0&&bounds.height>0?{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}:null;
      setRect(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
      frame=requestAnimationFrame(measure);
    };
    measure();return()=>cancelAnimationFrame(frame);
  },[active,chat]);
  useEffect(()=>{
    const guest=node.current;if(!native||!guest)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=()=>{try{guests.set(chat,guest);statuses.set(chat,{...(statuses.get(chat)??empty),back:guest.canGoBack(),forward:guest.canGoForward()});const current=guest.getURL();if(/^https?:\/\//.test(current)&&current!==ui.get().panels[chat]?.browserUrl)rememberBrowserUrl(chat,current,false);notify();}catch{}};
    const state=(patch:Partial<Status>)=>{statuses.set(chat,{...(statuses.get(chat)??empty),...patch});notify();};
    const ready=()=>{update();if(guest.getURL()!==latest.current)void guest.loadURL(latest.current).catch(()=>{});};
    const start=()=>state({loading:true,error:""});
    const stop=()=>{state({loading:false});update();};
    const fail=(event:Event)=>{const e=event as Event&{errorCode:number;errorDescription:string;isMainFrame:boolean};if(e.isMainFrame&&e.errorCode!==-3)state({error:e.errorDescription,loading:false});};
    const crash=()=>{const next=planWebviewCrashRecovery(recovery.current,Date.now());state({error:"Browser page stopped. Reload to try again.",loading:false});if(next){recovery.current=next.state;timer=setTimeout(()=>setGeneration(v=>v+1),next.delayMs);}};
    const events:{[name:string]:EventListener}={"dom-ready":ready,"did-navigate":update,"did-navigate-in-page":update,"did-start-loading":start,"did-stop-loading":stop,"did-fail-load":fail,"render-process-gone":crash};
    Object.entries(events).forEach(([name,handler])=>guest.addEventListener(name,handler));
    return()=>{clearTimeout(timer);Object.entries(events).forEach(([name,handler])=>guest.removeEventListener(name,handler));guests.delete(chat);statuses.delete(chat);notify();};
  },[native,chat,generation]);
  useEffect(()=>{const guest=guests.get(chat);if(guest&&guest.getURL()!==url)void guest.loadURL(url).catch(()=>{});},[chat,url]);
  const style=resolveHostedBrowserWebviewWrapperStyle({active,renderingActive:false,rect,hiddenSize:{width:900,height:650},zIndex:20});
  return <div style={{position:"fixed",...style}} data-browser-host={chat}>{native?createElement("webview",{key:generation,ref:(element:Guest|null)=>{node.current=element;},src:generation?latest.current:initial,partition:"persist:beam-preview-v1",webpreferences:"contextIsolation=true,sandbox=true,nodeIntegration=false",style:{display:"flex",width:"100%",height:"100%"}}):<iframe title="Web preview" src={url} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" style={{width:"100%",height:"100%",border:0,background:"white"}} />}</div>;
}
