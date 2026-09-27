import { useState } from "react";
import { bodyLevel, estimateDomain3dCells, DOMAIN3D_CELL_BUDGET, type Domain3DCase } from "@beam/contracts";
const fmt=(n:number)=>Number(n.toPrecision(4));
const vec=(p:readonly number[])=>`(${p.map(fmt).join(", ")})`;
/** Setup rail for 3-D studies. Geometry and boundaries are composed through chat; values here are editable. */
export function Domain3DRail({config:c,change}:{config:Domain3DCase;change:(c:Domain3DCase)=>void}){
 const [selected,setSelected]=useState("region");
 const number=(label:string,value:number,set:(n:number)=>void,unit="")=><label className="sim-value" key={label}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={value} onChange={e=>{if(e.target.value!==""&&Number.isFinite(e.target.valueAsNumber))set(e.target.valueAsNumber);}}/><i>{unit}</i></span></label>;
 const fact=(label:string,value:string)=><div className="sim-value" key={label}><span>{label}</span><span>{value}</span></div>;
 const body=c.bodies.find(b=>`body:${b.name}`===selected),boundary=c.boundaries.find(b=>`boundary:${b.name}`===selected);
 const faces=(name:string)=>Object.entries(c.domain.faces).filter(([,n])=>n===name).map(([f])=>f).join(" ");
 let estimate:ReturnType<typeof estimateDomain3dCells>|null=null;try{estimate=estimateDomain3dCells(c);}catch{estimate=null;}
 return <>
  <div className="sim-section-title">REGIONS <span>1</span></div><button className={`sim-row ${selected==="region"?"selected":""}`} onClick={()=>setSelected("region")}>■ {c.region.name}<span>fluid</span></button>
  <div className="sim-section-title">GEOMETRY <span>{c.bodies.length} bodies</span></div><button className={`sim-row ${selected==="domain"?"selected":""}`} onClick={()=>setSelected("domain")}>■ Box domain<span>6 faces</span></button>{c.bodies.map(b=><button key={b.name} className={`sim-row ${body===b?"selected":""}`} onClick={()=>setSelected(`body:${b.name}`)}>■ {b.name}<span>{b.shape}</span></button>)}
  <div className="sim-section-title">BOUNDARIES <span>{c.boundaries.length}</span></div>{c.boundaries.map(b=><button key={b.name} className={`sim-row ${boundary===b?"selected":""}`} onClick={()=>setSelected(`boundary:${b.name}`)}>■ {b.name}<span>{b.type==="velocity-inlet"?`${fmt(Math.hypot(...b.velocity))} m/s`:b.type==="pressure-outlet"?`${b.pressure} Pa`:b.type}</span></button>)}
  <div className="sim-section-title">{body?.name??boundary?.name??selected} <span>SELECTED</span></div>
  {selected==="region"&&<><label className="sim-value"><span>material</span><input aria-label="Material label" value={c.region.material} onChange={e=>change({...c,region:{...c.region,material:e.target.value}})}/></label>{number("density",c.region.density,n=>change({...c,region:{...c.region,density:n}}),"kg/m³")}{number("viscosity",c.region.nu,n=>change({...c,region:{...c.region,nu:n}}),"m²/s")}<p>Constant properties are explicit. The material name does not load a property database.</p></>}
  {selected==="domain"&&<>{fact("min",vec(c.domain.min))}{fact("max",vec(c.domain.max))}{Object.entries(c.domain.faces).map(([f,n])=>fact(f,n))}<p>Axis-aligned box; z is drawn upward. Ask the agent to resize the domain or reassign faces.</p></>}
  {body&&<>{body.shape==="sphere"?<>{fact("centre",vec(body.centre))}{fact("radius",`${fmt(body.radius)} m`)}</>:body.shape==="box"?<>{fact("min",vec(body.min))}{fact("max",vec(body.max))}</>:<>{fact("start",vec(body.start))}{fact("end",vec(body.end))}{fact("radius",`${fmt(body.radius)} m`)}</>}{fact("surface level",`${bodyLevel(c,body)} · ${fmt(c.meshSize/2**bodyLevel(c,body)*1000)} mm`)}<p>Excluded from the fluid region. Surface: {body.boundary}. No solid physics is solved inside this body.</p></>}
  {boundary&&faces(boundary.name)&&fact("faces",faces(boundary.name))}
  {boundary?.type==="velocity-inlet"&&([0,1,2] as const).map(k=>number(`velocity ${"xyz"[k]}`,boundary.velocity[k],n=>change({...c,boundaries:c.boundaries.map(b=>b===boundary?{...boundary,velocity:boundary.velocity.map((v,j)=>j===k?n:v) as [number,number,number]}:b)}),"m/s"))}
  {boundary?.type==="pressure-outlet"&&number("gauge pressure",boundary.pressure,n=>change({...c,boundaries:c.boundaries.map(b=>b===boundary?{...boundary,pressure:n}:b)}),"Pa")}
  {boundary?.type==="wall"&&<p>No-slip wall.{c.turbulence.model!=="laminar"?" k-ω SST uses wall functions; no boundary-layer cells are meshed.":""}</p>}
  {boundary?.type==="symmetry"&&<p>Symmetry plane: zero normal velocity and zero normal gradients.</p>}
  <div className="sim-section-title">PHYSICS</div>
  <label className="sim-value"><span>turbulence</span><select aria-label="Turbulence model" value={c.turbulence.model} onChange={e=>change({...c,turbulence:e.target.value==="laminar"?{model:"laminar"}:{model:"kOmegaSST",intensity:.02,lengthScale:c.meshSize}})}><option value="laminar">Laminar</option><option value="kOmegaSST">k-ω SST</option></select></label>
  {c.turbulence.model==="kOmegaSST"&&<>{number("inlet intensity",c.turbulence.intensity,n=>change({...c,turbulence:{...c.turbulence as {model:"kOmegaSST";intensity:number;lengthScale:number},intensity:n}}),"")}{number("length scale",c.turbulence.lengthScale,n=>change({...c,turbulence:{...c.turbulence as {model:"kOmegaSST";intensity:number;lengthScale:number},lengthScale:n}}),"m")}</>}
  {number("duration",c.duration,n=>change({...c,duration:n}),"s")}{number("saved frames",c.frames,n=>change({...c,frames:Math.round(n)}),"")}
  <p>Transient incompressible isothermal flow · pimpleFoam{c.turbulence.model==="kOmegaSST"?" with URANS k-ω SST; inlet k and ω follow from intensity and length scale":""}. Playback samples {c.slices.map(s=>`${s.name} (${s.normal} = ${fmt(s.offset)} m)`).join(", ")} and every wall.</p>
  <div className="sim-section-title">MESH</div>{fact("background",`${fmt(c.meshSize*1000)} mm hex`)}{(c.refinements??[]).map(r=>fact(r.name,`level ${r.level} · ${r.kind==="body"?`${r.body} +${fmt(r.distance)} m`:"box"}`))}{estimate&&fact("estimated cells",`${estimate.estimated.toLocaleString()} / ${DOMAIN3D_CELL_BUDGET.toLocaleString()}`)}
  <p>snappyHexMesh castellates and snaps to the bodies; boundary layers are not added. The estimate is conservative; meshing reports the actual count.</p>
 </>;
}
