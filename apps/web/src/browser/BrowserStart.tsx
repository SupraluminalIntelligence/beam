import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { ui, useUi } from "../lib/ui";

export function rememberBrowserUrl(chat:string,url:string,navigate=true) {
  const current=ui.get().panels[chat]?.browserHistory??[];
  ui.panel(chat,{browserUrl:url,...(navigate?{browserHome:false}:{}),browserHistory:[{url,at:Date.now()},...current.filter(e=>e.url!==url)].slice(0,50)});
}
function age(at:number) {const minutes=Math.max(0,Math.floor((Date.now()-at)/60_000));return minutes<1?"just now":minutes<60?`${minutes} min ago`:minutes<1440?`${Math.floor(minutes/60)} hr ago`:`${Math.floor(minutes/1440)} days ago`;}
/** T3 PreviewEmptyState's grouped discovery layout, using Beam's local bridge and UI store. */
export function BrowserStart({chat,onOpen}:{chat:string;onOpen:(url:string)=>void}) {
  const recent=(useUi().panels[chat]?.browserHistory??[]).filter(entry=>{try{return ["http:","https:"].includes(new URL(entry.url).protocol);}catch{return false;}});
  const [servers,setServers]=useState<{url:string;port:number;processName:string}[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  useEffect(()=>{
    const scan=bridge()?.localServers;if(!scan){setLoading(false);return;}
    let disposed=false;
    const refresh=async()=>{try{const found=await scan();if(!disposed){setServers(found);setError("");}}catch{if(!disposed)setError("Could not check local servers.");}finally{if(!disposed)setLoading(false);}};
    void refresh();const timer=setInterval(()=>void refresh(),15_000);return()=>{disposed=true;clearInterval(timer);};
  },[]);
  return <div className="browser-start"><div>
    <section><h2><HistoryIcon /> Recently used</h2>{recent.length?<div className="browser-discovery">{recent.slice(0,8).map(entry=><div className="browser-recent-row" key={entry.url}><button onClick={()=>onOpen(entry.url)}><span className="browser-page-icon">▱</span><span><b>{new URL(entry.url).host + (new URL(entry.url).pathname==="/"?"":new URL(entry.url).pathname)}</b><small>{age(entry.at)}</small></span></button><button className="browser-forget" aria-label={`Remove ${entry.url} from recent pages`} onClick={()=>ui.panel(chat,{browserHistory:recent.filter(e=>e.url!==entry.url)})}>×</button></div>)}</div>:<p>Pages you open will appear here.</p>}</section>
    <section><h2><ServerIcon /> Local servers</h2>{servers.length?<div className="browser-discovery">{servers.map(server=><button key={server.url} onClick={()=>onOpen(server.url)}><span className="browser-page-icon">▱</span><span><b>{server.processName}</b><small>localhost:{server.port}</small></span></button>)}</div>:<p>{loading?"Checking local servers…":error||(!bridge()?.localServers?"Open Beam desktop to discover servers on this machine.":"No web servers detected. Start a local app, or enter its URL above.")}</p>}{servers.length>0&&<p>Select a live local server to open it in this browser tab.</p>}</section>
  </div></div>;
}

function HistoryIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 4v5h5M3.4 9A9 9 0 1 1 3 15M12 7v5l3 2"/></svg>;}
function ServerIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="8" r="1.5"/><path d="m12 11-4 11m4-11 4 11M8 17h8M7 4a7 7 0 0 0 0 9M17 4a7 7 0 0 1 0 9M4 1a11 11 0 0 0 0 15M20 1a11 11 0 0 1 0 15"/></svg>;}
