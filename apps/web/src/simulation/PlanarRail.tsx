import { MotionControls } from "./MotionControls";
import { Refinements } from "./Refinements";
import { useState } from "react";
import type { PlanarCase } from "@beam/contracts";
export function PlanarRail({config:c,change}:{config:PlanarCase;change:(c:PlanarCase)=>void}){
 const [selected,setSelected]=useState("region");
 const number=(label:string,value:number,set:(n:number)=>void,unit="")=><label className="sim-value" key={label}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={value} onChange={e=>{if(e.target.value!==""&&Number.isFinite(e.target.valueAsNumber))set(e.target.valueAsNumber);}}/><i>{unit}</i></span></label>;
 const body=c.bodies.find(b=>`body:${b.name}`===selected),boundary=c.boundaries.find(b=>`boundary:${b.name}`===selected);
 return <>
  <div className="sim-section-title">REGIONS <span>1</span></div><button className={`sim-row ${selected==="region"?"selected":""}`} onClick={()=>setSelected("region")}>■ {c.region.name}<span>fluid</span></button>
  <div className="sim-section-title">GEOMETRY <span>{c.bodies.length} bodies</span></div><button className={`sim-row ${selected==="domain"?"selected":""}`} onClick={()=>setSelected("domain")}>■ Outer domain<span>{c.domain.vertices.length} edges</span></button>{c.bodies.map(b=><button key={b.name} className={`sim-row ${body===b?"selected":""}`} onClick={()=>setSelected(`body:${b.name}`)}>■ {b.name}<span>{b.shape}</span></button>)}
  <div className="sim-section-title">BOUNDARIES <span>{c.boundaries.length}</span></div>{c.boundaries.map(b=><button key={b.name} className={`sim-row ${boundary===b?"selected":""}`} onClick={()=>setSelected(`boundary:${b.name}`)}>■ {b.name}<span>{b.type==="velocity-inlet"?`${Math.hypot(...b.velocity).toPrecision(3)} m/s`:b.type==="pressure-outlet"?`${b.pressure} Pa`:b.type}</span></button>)}
  <div className="sim-section-title">{body?.name??boundary?.name??selected} <span>SELECTED</span></div>
  {selected==="region"&&<><label className="sim-value"><span>material</span><input aria-label="Material label" value={c.region.material} onChange={e=>change({...c,region:{...c.region,material:e.target.value}})}/></label>{number("density",c.region.density,n=>change({...c,region:{...c.region,density:n}}),"kg/m³")}{number("viscosity",c.region.nu,n=>change({...c,region:{...c.region,nu:n}}),"m²/s")}<p>Constant properties are explicit. The material name does not load a property database.</p></>}
  {selected==="domain"&&c.domain.vertices.map((p,i)=><div key={i}><div className="sim-section-title">Vertex {i+1} · {c.domain.edgeBoundaries[i]}</div>{([0,1] as const).map(k=>number(`${k===0?"x":"y"} ${i+1}`,p[k],n=>change({...c,domain:{...c.domain,vertices:c.domain.vertices.map((v,j)=>j===i?k===0?[n,v[1]]:[v[0],n]:v)}}),"m"))}</div>)}
  {body?.shape==="circle"&&<>{([0,1] as const).map(k=>number(k===0?"centre x":"centre y",body.centre[k],n=>change({...c,bodies:c.bodies.map(b=>b===body?{...body,centre:k===0?[n,body.centre[1]]:[body.centre[0],n]}:b)}),"m"))}{number("radius",body.radius,n=>change({...c,bodies:c.bodies.map(b=>b===body?{...body,radius:n}:b)}),"m")}</>}
  {body?.shape==="polygon"&&body.vertices.map((p,i)=><div key={i}>{([0,1] as const).map(k=>number(`vertex ${i+1} ${k===0?"x":"y"}`,p[k],n=>change({...c,bodies:c.bodies.map(b=>b===body?{...body,vertices:body.vertices.map((v,j)=>j===i?k===0?[n,v[1]]:[v[0],n]:v)}:b)}),"m"))}</div>)}
  {body&&<p>Excluded from the fluid region. Surface: {body.boundary}. No solid physics is solved inside this body.</p>}
  {boundary?.type==="velocity-inlet"&&([0,1] as const).map(k=>number(k===0?"velocity x":"velocity y",boundary.velocity[k],n=>change({...c,boundaries:c.boundaries.map(b=>b===boundary?{...boundary,velocity:k===0?[n,boundary.velocity[1]]:[boundary.velocity[0],n]}:b)}),"m/s"))}
  {boundary?.type==="pressure-outlet"&&number("gauge pressure",boundary.pressure,n=>change({...c,boundaries:c.boundaries.map(b=>b===boundary?{...boundary,pressure:n}:b)}),"Pa")}
  {boundary?.type==="wall"&&<p>No-slip velocity; pressure has zero normal gradient.</p>}{boundary?.type==="symmetry"&&<p>Zero normal velocity and zero normal gradients of tangential velocity and pressure.</p>}
  <MotionControls config={c} change={change}/><Refinements config={c} change={change}/>
  <div className="sim-section-title">PHYSICS</div><p>Transient incompressible, laminar, isothermal flow · pimpleFoam. Ask the agent to change geometry or boundary assignments. Every saved change creates a study revision.</p>
  {number("mesh size",c.meshSize,n=>change({...c,meshSize:n}),"m")}{number("duration",c.duration,n=>change({...c,duration:n}),"s")}{number("saved frames",c.frames,n=>change({...c,frames:n}))}
  {([0,1] as const).map(k=>number(k===0?"initial Ux":"initial Uy",c.initialVelocity[k],n=>change({...c,initialVelocity:k===0?[n,c.initialVelocity[1]]:[c.initialVelocity[0],n]}),"m/s"))}
 </>;
}
