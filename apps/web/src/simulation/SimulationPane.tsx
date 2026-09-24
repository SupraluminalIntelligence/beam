import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { SimulationCase, defaultChannel, defaultCylinder, defaultPlanar, PlanarMeshView, WakeFields, decodeWakeFrames, decodeWakeGeometry, meshKey, SimulationFields, SimulationReport, jobFinished } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui, useUi } from "../lib/ui";
import { ChannelDrawing, ResidualPlot } from "./figures";
import { WakeViewer } from "./WakeViewer";
import { Refinements } from "./Refinements";
import { MotionControls } from "./MotionControls";
import { PlanarRail } from "./PlanarRail";
import { SimulationProgress, simulationPhase } from "./SimulationProgress";
import "./simulation.css";

type Stage = "setup" | "mesh" | "runs" | "results";
type CaseRow = { _id: Id<"simulationCases">; name: string; revision: number; config: unknown };
const fmt = (n:number|null|undefined,unit="") => n == null ? "—" : `${Number(n.toPrecision(4))}${unit ? ` ${unit}` : ""}`;

export default function SimulationPane({chatId}:{chatId:Id<"chats">}) {
  const context=useQuery(api.compute.studyContext,{chatId}),cases=context?.studies, panel=useUi().panels[chatId];
  const selectStudy=useMutation(api.compute.selectSimulation);
  const jobs=useQuery(api.compute.list,{chatId}) ?? [], targets=useQuery(api.compute.targets,{chatId}) ?? [];
  const save=useMutation(api.compute.saveSimulation), submit=useMutation(api.compute.submitSimulation), cancel=useMutation(api.compute.cancel);
  const [caseId,setCaseId]=useState<Id<"simulationCases">|undefined>(),[revision,setRevision]=useState(0),[name,setName]=useState("Heated channel"),[config,setConfig]=useState<SimulationCase>({...defaultChannel});
  const [baseline,setBaseline]=useState(""),[stage,setStage]=useState<Stage>("setup"),[section,setSection]=useState("geometry"),[rail,setRail]=useState(true);
  const [runner,setRunner]=useState(""),[selected,setSelected]=useState<Id<"computeJobs">|undefined>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [field,setField]=useState<"velocity"|"pressure"|"temperature">("velocity"),[residualField,setResidualField]=useState("p_rgh");
  const initialized=useRef(false), selectionKey=useRef<number|undefined>(undefined), request=useRef<{fingerprint:string;key:string}|null>(null);
  const fingerprint=JSON.stringify({name,config}),dirty=fingerprint!==baseline;
  const valid=SimulationCase.safeParse(config);
  function load(row:CaseRow){const c=SimulationCase.parse(row.config);setCaseId(row._id);setRevision(row.revision);setName(row.name);setConfig(c);setBaseline(JSON.stringify({name:row.name,config:c}));setSelected(undefined);setResidualField(c.geometry==="channel"?"p_rgh":"p");setError("");}
  useEffect(()=>{if(cases!==undefined&&!initialized.current){initialized.current=true;const initial=cases.find(c=>c._id===context?.activeStudyId)??cases[0];if(initial)load(initial);}},[cases,context?.activeStudyId]);
  useEffect(()=>{ui.panel(chatId,{studyDraft:dirty&&initialized.current});return()=>ui.panel(chatId,{studyDraft:false});},[chatId,dirty,fingerprint]);
  useEffect(()=>{
    const selection=panel?.simulationSelection;if(!selection||selection.key===selectionKey.current||!cases)return;
    if(dirty&&caseId){setError("Save or discard your draft before opening another study or run.");return;}
    const row=cases.find(c=>c._id===selection.studyId);if(!row)return;
    selectionKey.current=selection.key;load(row);setStage(selection.stage);setSelected(selection.jobId as Id<"computeJobs">|undefined);
  },[panel?.simulationSelection,cases,dirty,caseId]);
  useEffect(()=>{const saved=cases?.find(c=>c._id===caseId);if(saved&&saved.revision!==revision&&!dirty&&!busy)load(saved);},[cases,caseId,revision,dirty,busy]);
  const caseJobs=caseId?jobs.filter(j=>j.simulation?.caseId===caseId):[];
  const mesh=caseJobs.find(j=>j.state==="succeeded"&&j.simulation?.stage==="mesh"&&meshKey(j.simulation.config)===meshKey(config));
  const stageJobs=caseJobs.filter(j=>stage==="mesh"?j.simulation?.stage==="mesh":j.simulation?.stage==="solve");
  const jobId=selected && stageJobs.some(j=>j._id===selected) ? selected : stageJobs[0]?._id;
  const job=useQuery(api.compute.get,jobId?{id:jobId}:"skip");
  const activeJob=caseJobs.find(j=>!jobFinished(j.state));
  const activeDetail=useQuery(api.compute.get,activeJob&&activeJob._id!==jobId?{id:activeJob._id}:"skip");
  const progressDetail=activeJob?activeJob._id===jobId?job:activeDetail:null;
  const detail=job?.spec.simulation;
  const [assets,setAssets]=useState<{id:string;report:SimulationReport|null;meshView:PlanarMeshView|null;fields:SimulationFields|null;wake:{fields:WakeFields;frames:Float32Array;geometry:Float32Array|null}|null;error:string}|null>(null);
  const reportAsset=job?.outputs.find(o=>o.path==="report.json"), fieldAsset=job?.outputs.find(o=>o.path==="fields.json"), frameAsset=job?.outputs.find(o=>o.path==="frames.bin");
  const geometryAsset=job?.outputs.find(o=>o.path==="geometry.bin");
  const meshViewAsset=job?.outputs.find(o=>o.path==="mesh-view.json");
  useEffect(()=>{
    if(!jobId||!reportAsset?.url||job?.state!=="succeeded"){setAssets(null);return;}
    const controller=new AbortController();const id=jobId;
    async function read(url:string,max:number){const r=await fetch(url,{signal:controller.signal});if(!r.ok||!r.body)throw new Error("Result download failed");const chunks:Uint8Array[]=[];let size=0;const reader=r.body.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error("Result exceeds size limit");chunks.push(value);}}finally{await reader.cancel();}const bytes=new Uint8Array(size);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length;}return bytes;}
    void (async()=>{try{
      const json=async(url:string)=>JSON.parse(new TextDecoder().decode(await read(url,8e6)));
      const report=SimulationReport.parse(await json(reportAsset!.url!));
      let fields:SimulationFields|null=null,wake:{fields:WakeFields;frames:Float32Array;geometry:Float32Array|null}|null=null;
      if(fieldAsset?.url){const raw=await json(fieldAsset.url);if(report.config.geometry!=="channel"){
        const manifest=WakeFields.parse(raw);if(!frameAsset?.url)throw new Error("Playback frames are missing");
        const bytes=await read(frameAsset.url,20e6);if(report.config.geometry==="planar"&&report.config.motion&&!manifest.motion)throw new Error("Moving mesh coordinates are missing");
        const geometry=manifest.motion?(geometryAsset?.url?decodeWakeGeometry((await read(geometryAsset.url,20e6)).buffer as ArrayBuffer,manifest):null):null;
        if(manifest.motion&&!geometry)throw new Error("Moving mesh coordinates are missing");
        wake={fields:manifest,frames:decodeWakeFrames(bytes.buffer as ArrayBuffer,manifest),geometry};
      }else fields=SimulationFields.parse(raw);}
      if((fields&&fields.centres.length!==report.cells)||(wake&&wake.fields.centres.length!==report.cells))throw new Error("Result does not match its mesh");
      const meshView=meshViewAsset?.url?PlanarMeshView.parse(await json(meshViewAsset.url)):null;
      if(meshView&&meshView.polygons.length!==report.cells)throw new Error("Mesh preview does not match its report");
      if(!controller.signal.aborted)setAssets({id,report,fields,wake,meshView,error:""});
    }catch(e){if(!controller.signal.aborted)setAssets({id,report:null,fields:null,wake:null,meshView:null,error:(e as Error).message});}})();
    return()=>controller.abort();
  },[jobId,job?.state,reportAsset?.url,fieldAsset?.url,frameAsset?.url,meshViewAsset?.url,geometryAsset?.url]);
  const report=assets && assets.id===jobId?assets.report:null,fields=assets && assets.id===jobId?assets.fields:null,wake=assets&&assets.id===jobId?assets.wake:null;
  const target=targets.find(t=>t.id===runner)??targets.find(t=>t.openfoam?.ready)??targets[0];
  const current=cases?.find(c=>c._id===caseId),conflict=!!current&&current.revision!==revision;
  const active=!!activeJob;
  const outputOld=!!detail&&(detail.revision!==revision||dirty);
  const shown=stage==="setup"?config:detail?.config??config;
  const running=job&&!jobFinished(job.state);
  const currentJobs=caseJobs.filter(j=>JSON.stringify(SimulationCase.parse(j.simulation!.config))===JSON.stringify(config));
  const stageJob=(s:Stage)=>s==="setup"?undefined:s==="mesh"?caseJobs.find(j=>j.simulation?.stage==="mesh"&&meshKey(j.simulation.config)===meshKey(config)):currentJobs.find(j=>j.simulation?.stage==="solve");
  const stageTone=(s:Stage)=>{const j=stageJob(s);return j?.state==="awaiting-approval"?"attention":j&&(j.state==="queued"||j.cancelRequestedAt&&!jobFinished(j.state))?"waiting":j&&!jobFinished(j.state)?"working":j?.state==="failed"?"failed":"";};
  const stageDescription=(s:Stage)=>{const j=stageJob(s);if(j&&!jobFinished(j.state))return simulationPhase(j);return s==="setup"?`1 region · ${config.geometry==="channel"?3:config.geometry==="planar"?config.boundaries.length:4} boundaries`:s==="mesh"?(mesh?"checked":"not generated"):s==="runs"?`${caseJobs.filter(j=>j.simulation?.stage==="solve").length}`:"fields";};
  const status=(s:Stage)=>s==="setup"?(valid.success?"■":"◩"):stageTone(s)==="working"?"■":stageTone(s)==="attention"?"◩":stageTone(s)==="waiting"?"□":stageTone(s)==="failed"?"◩":s==="mesh"?(mesh?"■":"□"):stageJob(s)?.state==="succeeded"?"■":"□";
  async function saveCase(){const c=SimulationCase.parse(config);const result=await save({chatId,name,config:c,...(caseId?{id:caseId,revision}:{})});setCaseId(result.id);setRevision(result.revision);setConfig(c);setBaseline(JSON.stringify({name,config:c}));return result;}
  async function action(fn:()=>Promise<unknown>){setBusy(true);setError("");try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function launch(kind:"mesh"|"solve"){
    if(!target?.openfoam?.ready)throw new Error("Connect a runner with the OpenFOAM runtime first");
    if(kind==="solve"&&!mesh)throw new Error("Build and check a mesh for this geometry first");
    const saved=await saveCase();const fp=JSON.stringify([saved.id,saved.revision,kind,target.id,kind==="solve"?mesh?._id:null]);
    if(request.current?.fingerprint!==fp)request.current={fingerprint:fp,key:crypto.randomUUID()};
    const id=await submit({chatId,caseId:saved.id,revision:saved.revision,runnerId:target.id,stage:kind,requestKey:request.current.key,...(kind==="solve"&&mesh?{meshJobId:mesh._id}:{})});
    request.current=null;setSelected(id);setStage(kind==="mesh"?"mesh":"runs");
  }
  function update(k:string,value:unknown){setConfig(c=>({...c,[k]:value}) as SimulationCase);}
  const input=(k:string,label:string,unit:string,scale=1)=><label className="sim-value" key={k}><span>{label}</span><span><NumericInput label={label} value={Number((config as unknown as Record<string,unknown>)[k])*scale} change={n=>update(k,n/scale)} disabled={busy}/><i>{unit}</i></span></label>;
  const fact=(label:string,value:string)=><div className="sim-value" key={label}><span>{label}</span><span>{value}</span></div>;
  const startNew=(kind:"channel"|"cylinder"|"planar"="channel")=>{setCaseId(undefined);setRevision(0);setName(kind==="channel"?"Heated channel":kind==="planar"?"Three-cylinder flow":"Cylinder wake");setConfig(kind==="channel"?{...defaultChannel}:kind==="planar"?structuredClone(defaultPlanar):{...defaultCylinder});setBaseline("");setSelected(undefined);setStage("setup");setResidualField(kind==="channel"?"p_rgh":"p");setError("");};
  return <div className="simulation">
    <header className="sim-modelbar"><input aria-label="Study name" className="sim-name" value={name} onChange={e=>setName(e.target.value)} maxLength={100}/>{caseId&&context?.activeStudyId!==caseId&&<button disabled={busy} onClick={()=>void action(()=>selectStudy({chatId,caseId}))}>Use in chat</button>}<span className="sim-meta">{config.geometry==="channel"?"2D channel":config.geometry==="planar"?"2D fluid domain":"2D cylinder wake"} · {revision?`rev ${revision}`:"new study"}{dirty?" · draft":""}</span><div className="sim-actions"><button disabled={busy||!valid.success||conflict||!dirty} onClick={()=>void action(saveCase)}>Save</button><button disabled={busy||active||conflict||!valid.success||!target?.openfoam?.ready} onClick={()=>void action(()=>launch("mesh"))}>Mesh</button><button className="sim-primary" disabled={busy||active||conflict||!valid.success||!mesh||!target?.openfoam?.ready} onClick={()=>void action(()=>launch("solve"))}>Run</button></div></header>
    <nav className="sim-stages" aria-label="Simulation stages">{(["setup","mesh","runs","results"] as const).map(s=><button key={s} className={stageTone(s)} aria-current={stage===s?"step":undefined} onClick={()=>{setStage(s);setSelected(undefined);}}><span>{status(s)}</span> {s}<small>{stageDescription(s)}</small></button>)}<button className="sim-rail-toggle" aria-pressed={rail} onClick={()=>setRail(!rail)}>{rail?"■":"□"} Rail</button></nav>
    {activeJob&&<SimulationProgress key={activeJob._id} job={{...activeJob,...(progressDetail?{runnerOnline:progressDetail.runnerOnline}:{})}} onOpen={()=>ui.openSurface(chatId,`job:${activeJob._id}`)}/>}
    {(error||assets?.error||conflict)&&<div role="alert" className="sim-message">{error||assets?.error||"This study changed elsewhere. Reload to review those edits before saving."}{conflict&&<button onClick={()=>current&&load(current)}>Reload saved study</button>}</div>}
    <div className={`sim-body ${rail?"":"no-rail"}`}>
      <main className="sim-canvas">
        {stage==="runs"?<><div className="sim-figure-head"><span>RESIDUALS · INITIAL</span><select aria-label="Residual field" value={residualField} onChange={e=>setResidualField(e.target.value)}>{(config.geometry==="channel"?["p_rgh","Ux","Uy","T"]:["p","Ux","Uy"]).map(f=><option key={f}>{f}</option>)}</select></div><ResidualPlot rows={report?.residuals??[]} field={residualField}/><div className="sim-run-log"><div className="sim-section-title">JOB LOG <span>{job?.state.replaceAll("-"," ")??"not started"}</span></div><pre>{job?.log||(job?"Waiting for solver output…":"Run the saved case after building a mesh. Progress and solver output appear here.")}</pre></div></>:
          <>{shown.geometry!=="channel"?<WakeViewer config={shown} fields={stage==="results"?wake?.fields??null:null} frames={stage==="results"?wake?.frames??null:null} geometry={stage==="results"?wake?.geometry??null:null} mesh={stage==="mesh"&&!!report?.meshOk} meshView={assets&&assets.id===jobId?assets.meshView:null}/>:<><div className="sim-figure-head"><span>REGIONS 1 · BOUNDARIES 3 · L <b>{fmt(shown.length*1000,"mm")}</b> · H <b>{fmt(shown.height*1000,"mm")}</b></span><span>SECTION xy{outputOld?" · saved run":""}</span></div>
          {stage==="results"&&fields?<div className="sim-field-control"><select aria-label="Result field" value={field} onChange={e=>setField(e.target.value as typeof field)}><option value="velocity">Speed · m/s</option><option value="pressure">Gauge pressure · Pa</option><option value="temperature">Temperature · K</option></select><span>Cell values · iteration {report?.iterations}</span></div>:null}
          <ChannelDrawing config={shown} mesh={stage==="mesh"&&!!report?.meshOk} fields={stage==="results"?fields:null} field={field} select={setSection} section={section}/></>}
          {stage==="mesh"&&job?.log&&<details className="sim-mesh-log"><summary>Mesh log · {job.state}</summary><pre>{job.log}</pre></details>}
          {shown.geometry==="channel"&&<div className="sim-figure-caption"><span>Fig. 1 — {stage==="results"?(fields?"Computed cell field":"No computed fields yet"):stage==="mesh"?(report?.meshOk?"Checked structured mesh":"Mesh not generated"):"Fluid domain · dimensions specified"}</span><span>{stage==="results"&&fields?"Hover to inspect a cell":"Select a boundary to edit"}</span></div>}</>}
      </main>
      {rail&&<aside key={stage} className="sim-rail">
        <div className="sim-section-title">STUDY <button onClick={()=>startNew(config.geometry)} disabled={busy||dirty&&!!caseId} title={dirty&&caseId?"Save or reload before changing cases":"New simulation study"}>＋</button></div>
        <select aria-label="Saved study" value={caseId??""} disabled={busy||dirty&&!!caseId} onChange={e=>{const row=cases?.find(c=>c._id===e.target.value);if(row)void action(async()=>{await selectStudy({chatId,caseId:row._id});load(row);});}}><option value="">New study</option>{cases?.map(c=><option key={c._id} value={c._id}>{c.name}</option>)}</select>
        <div className="sim-section-title">NEW STUDY</div><select aria-label="New study type" value="" disabled={busy||!!caseId&&dirty} onChange={e=>{if(e.target.value)startNew(e.target.value as "channel"|"cylinder"|"planar");}}><option value="">Choose a study…</option><option value="channel">Heated channel · steady</option><option value="cylinder">Cylinder wake · animated</option><option value="planar">Planar flow · three-cylinder example</option></select>
        {dirty&&caseId&&<button className="sim-text-button" onClick={()=>current&&load(current)}>Discard draft · reload saved</button>}
        <div className="sim-section-title">RUNNER</div><select aria-label="Simulation runner" value={target?.id??""} onChange={e=>setRunner(e.target.value)}>{!targets.length&&<option value="">No runner connected</option>}{targets.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><p>{target?.openfoam?.ready?"OpenCFD OpenFOAM 2512 · Docker · local":target?.openfoam?.message??"Start an updated Beam runner and Docker to enable meshing and solving."}</p>
        {stage==="setup"?<>
          {config.geometry==="planar"?<PlanarRail config={config} change={setConfig}/>:config.geometry==="channel"?<>
          <div className="sim-section-title">REGIONS <span>1</span></div><button className={`sim-row ${section==="geometry"?"selected":""}`} onClick={()=>setSection("geometry")}>■ Fluid volume <span>channel</span></button>
          <div className="sim-section-title">BOUNDARIES <span>3</span></div>{["inlet","outlet","walls"].map(s=><button key={s} className={`sim-row ${section===s?"selected":""}`} onClick={()=>setSection(s)}>■ {s}<span>{s==="inlet"?fmt(config.velocity,"m/s"):s==="outlet"?"0 Pa":config.thermal?fmt(config.wallTemperature,"K"):"adiabatic"}</span></button>)}
          <div className="sim-section-title">{section} <span>SELECTED</span></div>
          {section==="geometry"?<>{input("length","length","mm",1000)}{input("height","height","mm",1000)}<p>2-D planar channel. This recipe creates the fluid domain directly. Importing and preparing arbitrary CAD is not available yet.</p></>:section==="inlet"?<>{input("velocity","velocity","m/s")}{input("inletTemperature","temperature","K")}</>:section==="outlet"?<>{fact("gauge pressure","0 Pa")}<p>Fixed pressure outlet; velocity and temperature use zero gradient.</p></>:<><label className="sim-value"><span>thermal</span><select value={config.thermal?"fixed":"adiabatic"} onChange={e=>update("thermal",e.target.value==="fixed")}><option value="fixed">Fixed T</option><option value="adiabatic">Adiabatic</option></select></label>{config.thermal&&input("wallTemperature","temperature","K")}<p>No-slip walls. Prescribed temperature has no solid wall region or conjugate heat transfer.</p></>}
          <div className="sim-section-title">MATERIAL · CONSTANT PROPERTIES</div>{input("nu","kinematic viscosity","m²/s")}{input("density","density","kg/m³")}{input("pr","Prandtl number","")}
          <div className="sim-section-title">PHYSICS</div>{fact("flow","steady · laminar")}{fact("gravity","0 m/s²")}{fact("Re · 2H",fmt(config.velocity*2*config.height/config.nu))}<p>buoyantBoussinesqSimpleFoam, with buoyancy disabled. Temperature is passively transported; properties remain constant.</p>
          </>:<>
            {config.version===1&&<button onClick={()=>update("version",2)}>Refine wake mesh</button>}<div className="sim-section-title">GEOMETRY</div>{input("diameter","diameter","mm",1000)}{fact("domain","20D × 8D")}
            <p>A circular cylinder in a planar fluid domain. The body-fitted mesh resolves its surface and downstream wake.</p>
            <div className="sim-section-title">BOUNDARIES <span>4</span></div>{fact("inlet",`${config.velocity} m/s →`)}{fact("outlet","0 Pa")}{fact("cylinder","no slip")}{fact("far field","symmetry")}
            <div className="sim-section-title">FLOW</div>{input("velocity","inlet speed","m/s")}{input("reynolds","Re · D","")}{input("density","density","kg/m³")}{fact("viscosity",fmt(config.velocity*config.diameter/config.reynolds,"m²/s"))}
            <div className="sim-section-title">TIME</div>{input("duration","duration","D/U")}{fact("physical duration",fmt(config.duration*config.diameter/config.velocity,"s"))}
            <p>Transient, laminar, isothermal flow using pimpleFoam. A 1% initial cross-flow perturbation seeds asymmetry; the inlet remains axial. The solver computes the wake.</p>
            <p>100 saved times. Adaptive time steps target Courant ≤ 0.7. This is a coarse demonstration; mesh and domain sensitivity have not been established.</p>
          </>}
          {!valid.success&&<p className="sim-warning">{valid.error.issues.map(i=>i.message).join(". ")}</p>}
        </>:<>
          <div className="sim-section-title">{stage==="mesh"?"MESH JOBS":"RUNS"} <span>{stageJobs.length}</span></div><select aria-label="Selected job" value={jobId??""} onChange={e=>setSelected(e.target.value as Id<"computeJobs">)}>{!stageJobs.length&&<option value="">Not started</option>}{stageJobs.map(j=><option key={j._id} value={j._id}>r{j.simulation?.revision} · {j.state} · {new Date(j.createdAt).toLocaleTimeString()}</option>)}</select>
          {shown.geometry==="planar"&&<MotionControls config={shown}/>}{report?.motion&&fact("checked moving frames",String(report.motion.checkedFrames))}{shown.geometry==="planar"&&stage!=="mesh"&&<Refinements config={shown}/>}
          {outputOld&&<p className="sim-warning">Previous run · revision {detail?.revision}. Current setup is revision {revision}{dirty?" with unsaved edits":""}.</p>}
          {stage==="mesh"?<><div className="sim-section-title">NEXT MESH</div>{config.geometry==="channel"?<>{input("nx","length cells","")}{input("ny","height cells","")}{fact("total cells",String(config.nx*config.ny))}</>:config.geometry==="planar"?<>{input("meshSize","mesh size","m")}{fact("mesh","constrained triangles")}<Refinements config={config} change={setConfig}/><p>Actual cell count and boundary coverage are checked when meshing.</p></>:<>{fact("cells",config.version===1?"5,568":"7,344")}{fact("mesh","body-fitted · graded")}</>}<div className="sim-section-title">MESH QUALITY</div>{fact("checkMesh",report?.meshOk?"passed":"not evaluated")}{fact("cells",fmt(report?.cells))}{fact("max non-ortho",fmt(report?.maxNonOrthogonality,"°"))}{fact("max skewness",fmt(report?.maxSkewness))}<p>Changing dimensions or cell counts requires a new mesh. Material and boundary edits can reuse a matching mesh.</p></>:stage==="runs"?<><div className="sim-section-title">NEXT RUN</div>{config.geometry==="channel"?input("iterations","iteration limit",""):input("duration","duration",config.geometry==="planar"?"s":"D/U")}<div className="sim-section-title">CONVERGENCE</div>{fact("iterations",fmt(report?.iterations))}{config.geometry==="channel"?<>{fact("criteria",report?(report.converged?"met":"not met"):"not evaluated")}<p>Initial residual thresholds: pressure 10⁻⁶; velocity and temperature 10⁻⁷. Meeting these alone does not validate the physics.</p></>:<>{fact("physical time",fmt(report?.physicalTime,"s"))}{fact("max Courant",fmt(report?.maxCourant))}<p>Transient flow remains unsteady. Residuals track the linear solves at each time step; steady convergence is not the goal.</p></>}</>:<><div className="sim-section-title">MEASUREMENTS</div>{shown.geometry==="channel"?<>{fact("pressure drop",fmt(report?.pressureDropPa,"Pa"))}{fact("outlet T",fmt(report?.outletTemperatureK,"K"))}<p>Estimates from the first and last cell columns; temperature is an arithmetic mean, not a flow-weighted outlet value.</p></>:<>{fact("physical time",fmt(report?.physicalTime,"s"))}{fact("saved times",String(wake?.fields.times.length??0))}{fact("max Courant",fmt(report?.maxCourant))}<p>Blue and amber show opposite rotation, not temperature. Playback interpolates between computed snapshots and restarts at the beginning.</p><p>Vorticity colour limits are ±2U/L (the displayed reference length) to reveal the wake; stronger near-wall values are clipped. Hover values remain unclipped.</p></>}<div className="sim-section-title">CHECKS</div>{fact("solver criteria",shown.geometry!=="channel"?(report?.physicalTime?"end time reached":"not evaluated"):report?(report.converged?"met":"not met"):"not evaluated")}{fact("mass balance","not evaluated")}{fact("thermal balance","not evaluated")}{fact("mesh sensitivity","not studied")}<p>No engineering validation is implied by a completed job. Check conservation and mesh sensitivity before relying on results.</p></>}
          {running&&<>{!job.runnerOnline&&<p className="sim-warning">Runner disconnected. Showing its last report; the job may still be running.</p>}<button disabled={busy||!!job.cancelRequestedAt} onClick={()=>void action(()=>cancel({id:job._id}))}>{job.cancelRequestedAt?"Cancelling…":"Cancel job"}</button></>}
          {job?.state==="awaiting-approval"&&<><p className="sim-warning">Waiting for the requester to approve this job.</p><button onClick={()=>ui.openSurface(chatId,`job:${job._id}`)}>Review job</button></>}
          {job?.error&&<p className="sim-warning">{job.error}</p>}
          {!!job?.outputs.length&&<><div className="sim-section-title">OUTPUTS</div>{job.outputs.map(o=><a className="sim-download" key={o.id} href={o.url??undefined} download={o.path} target="_blank" rel="noreferrer">{o.path} ↗</a>)}{job.outputs.some(o=>o.path==="case.tar.gz")&&<p>The case archive opens in ParaView using case.foam.</p>}</>}
        </>}
      </aside>}
    </div><footer className="sim-footer"><span>{(["setup","mesh","runs","results"] as const).map(s=><span key={s} className={stageTone(s)}>{status(s)} {s}　</span>)}</span><span>{busy?"Working…":dirty?"draft · unsaved changes":active?"job in progress":caseId?`saved · rev ${revision}`:"new study · nothing computed yet"}</span></footer>
  </div>;
}

function NumericInput({value,change,label,disabled}:{value:number;change:(n:number)=>void;label:string;disabled:boolean}){
  const [text,setText]=useState(String(value)),ref=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(document.activeElement!==ref.current)setText(String(value));},[value]);
  return <input ref={ref} aria-label={label} type="text" inputMode="decimal" value={text} disabled={disabled} onChange={e=>{setText(e.target.value);const n=Number(e.target.value);if(e.target.value.trim()&&Number.isFinite(n))change(n);}} onBlur={()=>setText(String(value))}/>;
}
