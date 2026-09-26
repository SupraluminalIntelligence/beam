import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { jobFinished, SimulationCase } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui, useUi } from "../lib/ui";
import { toast } from "../components/Toast";
import "./study.css";

export function StudyCard({id,chatId}:{id:Id<"simulationCases">;chatId:Id<"chats">}){
 const study=useQuery(api.compute.study,{id}),select=useMutation(api.compute.selectSimulation);
 const [busy,setBusy]=useState(false);
 if(!study)return <div className="study-card">{study===undefined?"Loading study…":"Study unavailable"}</div>;
 const latest=study.jobs[0],result=study.jobs.find(j=>j.simulation?.stage==="solve"&&j.state==="succeeded"),active=latest&&!jobFinished(latest.state);
 const previous=!!result&&result.simulation?.revision!==study.revision;
 const status=active?`${latest.simulation?.stage==="mesh"?"Mesh":"Run"} · ${latest.state.replaceAll("-"," ")}`:latest?.state==="failed"?"Run needs attention":latest?.state==="cancelled"?"Cancelled":result?previous?"Setup changed · previous results available":"Results ready":latest?.state==="succeeded"?"Mesh checked · ready to run":"Setup ready · nothing computed";
 const c=SimulationCase.parse(study.config),description=c.geometry==="planar"?`${c.region.name} · ${c.bodies.length} bodies · ${c.boundaries.length} boundaries`:c.geometry==="cylinder"?`Cylinder wake · ⌀ ${c.diameter*1000} mm · ${c.velocity} m/s`:`Heated channel · ${c.length*1000} × ${c.height*1000} mm · ${c.velocity} m/s`;
 async function open(results=false){setBusy(true);try{await select({chatId,caseId:id});ui.openSimulation(chatId,id,results?"results":active?(latest!.simulation?.stage==="mesh"?"mesh":"runs"):"setup",results?result?._id:active?latest!._id:undefined);}catch(e){toast((e as Error).message);}finally{setBusy(false);}}
 return <section className="study-card" aria-label={`Simulation study: ${study.name}`}>
  <div className="study-card-heading"><span className={`job-dot ${latest?.state??"queued"}`}/><b>{study.name}</b><small>Study · r{study.revision}</small></div>
  <p>{description}</p><div className="study-card-state" role="status">{status}</div>
  <div className="study-card-actions"><button disabled={busy} onClick={()=>void open()}>Open study ↗</button>{result&&<button disabled={busy} onClick={()=>void open(true)}>{previous?`View r${result.simulation?.revision} results`:"View results"} ↗</button>}{latest&&<button onClick={()=>ui.openSurface(chatId,`job:${latest._id}`)}>{latest.state==="awaiting-approval"?"Review job":"Job details"}</button>}</div>
 </section>;
}

/** A shared saved target, shown beside the actual message input. */
export function StudyContext({chatId,onDescribe}:{chatId:Id<"chats">;onDescribe:()=>void}){
 const context=useQuery(api.compute.studyContext,{chatId}),select=useMutation(api.compute.selectSimulation),[open,setOpen]=useState(false),[scope,setScope]=useState<"chat"|"workspace">("chat"),[busy,setBusy]=useState(false);
 const workspace=useQuery(api.compute.workspaceStudies,open&&scope==="workspace"?{chatId}:"skip");
 const state=useUi(),draft=state.panels[chatId]?.studyDraft;
 const active=context?.studies.find(s=>s._id===context.activeStudyId),previous=useRef<string|null|undefined>(undefined);
 useEffect(()=>{if(!context)return;const id=context.activeStudyId;if(previous.current!==undefined&&id&&id!==previous.current&&ui.get().panels[chatId]?.simulationSelection?.studyId!==id)ui.openSimulation(chatId,id,"setup");previous.current=id;},[context?.activeStudyId]);
 async function pick(id:Id<"simulationCases">|null,owner=chatId,workspaceId?:string){setBusy(true);try{await select({chatId:owner,caseId:id});setOpen(false);if(owner!==chatId&&workspaceId)ui.openChat(workspaceId,owner);if(id)ui.openSimulation(owner,id,"setup");}catch(e){toast((e as Error).message);}finally{setBusy(false);}}
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.stopPropagation();setOpen(false);}};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);};},[open]);
 return <div className="study-context" ref={root}>
  <button className={`tool-chip study-target${active?" on":""}`} aria-expanded={open} title={active?`Working study: ${active.name} r${active.revision}${draft?" · unsaved edits":""}`:"Pick or start a simulation study"} onClick={()=>setOpen(!open)}>
   <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h4M7 2v4L3.5 12.5A1 1 0 0 0 4.4 14h7.2a1 1 0 0 0 .9-1.5L9 6V2" /></svg>
   {active?<><b>{active.name}</b><span className="k">r{active.revision}{draft?" · unsaved":""}</span></>:"Study"}
   <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
  </button>
  {open&&<div className="study-picker">
   {active&&<button className="study-open" onClick={()=>{setOpen(false);ui.openSimulation(chatId,active._id,"setup");}}><span>Open {active.name}</span><small>r{active.revision}{draft?` · unsaved edits · the agent sees saved r${active.revision}`:""}</small></button>}<div className="study-picker-scope"><button aria-pressed={scope==="chat"} onClick={()=>setScope("chat")}>This chat</button><button aria-pressed={scope==="workspace"} onClick={()=>setScope("workspace")}>Workspace</button></div>
   {scope==="chat"?<>{context?.studies.map(s=><button disabled={busy} key={s._id} onClick={()=>void pick(s._id)}><span>{s.name}</span><small>{s._id===active?._id?"Working study · ":""}r{s.revision}</small></button>)}{!context?.studies.length&&<p>Describe a simulation in chat to create a study.</p>}</>:<>{workspace?.map(s=><button disabled={busy} key={s.id} onClick={()=>void pick(s.id,s.chatId,s.workspaceId)}><span>{s.name}</span><small>{s.chatTitle} · r{s.revision} ↗</small></button>)}<p>Workspace studies open in their original chat, with their conversation and run history.</p></>}
   <button onClick={()=>{setOpen(false);onDescribe();}}>＋ Describe a new study in chat</button>{active&&<button disabled={busy} onClick={()=>void pick(null)}>Clear working study</button>}
  </div>}
 </div>;
}
