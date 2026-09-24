import { useState } from "react";
import type { ChannelCase, SimulationFields, SimulationReport } from "@beam/contracts";

const number=(n:number)=>Number(n.toPrecision(4)).toString();
export function ChannelDrawing({config:c,mesh,fields,field,select,section}:{config:ChannelCase;mesh:boolean;fields:SimulationFields|null;field:"velocity"|"pressure"|"temperature";select:(s:string)=>void;section:string}){
  const [hover,setHover]=useState<number|null>(null);
  const x=150,y=200,w=700,h=Math.max(60,Math.min(300,w*c.height/c.length)),v=fields?.[field];
  const lo=v?Math.min(...v):0,hi=v?Math.max(...v):1,unit=field==="velocity"?"m/s":field==="pressure"?"Pa":"K";
  // Sequential luminance scale, separate from status colours. Every rect is a solver cell.
  const color=(n:number)=>`hsl(208 32% ${24+66*(hi===lo?.5:(n-lo)/(hi-lo))}%)`;
  return <div className="sim-drawing"><svg viewBox="0 0 1000 580" role="img" aria-label={fields?`${field} computed on ${fields.centres.length} cells`:`Channel: ${c.length*1000} mm long, ${c.height*1000} mm high`}>
    {fields?fields.centres.map((p,i)=><rect key={i} x={x+(p[0]/c.length-.5/c.nx)*w} y={y+(1-p[1]/c.height-.5/c.ny)*h} width={w/c.nx+.2} height={h/c.ny+.2} fill={color(v![i]!)} onPointerEnter={()=>setHover(i)} onPointerLeave={()=>setHover(null)}><title>{number(v![i]!)} {unit} · x {number(p[0]*1000)} mm · y {number(p[1]*1000)} mm</title></rect>):<rect x={x} y={y} width={w} height={h} className="sim-fluid" onClick={()=>select("geometry")}/>}
    {mesh&&!fields&&<g className="sim-grid">{Array.from({length:c.nx-1},(_,i)=><path key={`x${i}`} d={`M${x+(i+1)*w/c.nx} ${y}v${h}`}/>)}{Array.from({length:c.ny-1},(_,i)=><path key={`y${i}`} d={`M${x} ${y+(i+1)*h/c.ny}h${w}`}/>)}</g>}
    <path d={`M${x-30} ${y+h/2}H${x+w+30}`} stroke="var(--ink-3)" strokeDasharray="22 6 3 6" opacity=".5"/>
    <g className="sim-boundary" data-selected={section==="walls"} onClick={()=>select("walls")}><path d={`M${x} ${y}h${w}M${x} ${y+h}h${w}`}/><text x={x+w/2} y={y-24} textAnchor="middle">WALLS · {c.thermal?`${c.wallTemperature} K fixed`:"adiabatic"} · no slip</text></g>
    <g className="sim-boundary" data-selected={section==="inlet"} onClick={()=>select("inlet")}><path d={`M${x} ${y}v${h}M40 ${y+h/2}h70l-8 -5m8 5l-8 5`}/><text x="35" y={y+h/2-22}>INLET</text><text x="35" y={y+h/2+30}>{c.velocity} m/s</text><text x="35" y={y+h/2+48}>{c.inletTemperature} K</text></g>
    <g className="sim-boundary" data-selected={section==="outlet"} onClick={()=>select("outlet")}><path d={`M${x+w} ${y}v${h}M${x+w+30} ${y+h/2}h60l-8 -5m8 5l-8 5`}/><text x={x+w+30} y={y+h/2-22}>OUTLET</text><text x={x+w+30} y={y+h/2+30}>p 0 Pa</text></g>
    <g className="sim-dimensions"><path d={`M${x} ${y+h+20}v40m0 -10h${w}m0 -30v40M${x-15} ${y}h-14m7 0v${h}m-7 0h14`}/><text x={x+w/2} y={y+h+42} textAnchor="middle">{number(c.length*1000)} mm</text><text x={x-18} y={y-12} textAnchor="end">{number(c.height*1000)} mm</text></g>
    <text className="sim-scale-note" x={x} y={y+h+90}>{h!==w*c.height/c.length?"Vertical scale enlarged · planar section":"Planar section · proportional scale"}</text>
  </svg>{v&&<div className="sim-legend"><span>{number(lo)} {unit}</span><i style={{background:`linear-gradient(90deg,${color(lo)},${color(hi)})`}}/><span>{number(hi)} {unit}</span><span>{hover!==null?`cell ${hover+1} · ${number(v[hover]!)} ${unit}`:"Cell-centred field"}</span></div>}</div>;
}
export function ResidualPlot({rows,field}:{rows:SimulationReport["residuals"];field:string}){
  const points=rows.filter(r=>r.field===field),last=Math.max(1,...points.map(r=>r.iteration));
  const y=(v:number)=>30+Math.min(12,Math.max(0,-Math.log10(Math.max(1e-12,v))))/12*240;
  return <div className="sim-residuals"><svg viewBox="0 0 800 320" role="img" aria-label={`${field} initial residual versus iteration`}>
    {[0,3,6,9,12].map(n=><g key={n}><path d={`M60 ${30+n/12*240}H770`} stroke="var(--line)"/><text x="8" y={34+n/12*240}>1e−{n}</text></g>)}
    {!!points.length&&<polyline points={points.map(p=>`${60+p.iteration/last*710},${y(p.initial)}`).join(" ")} fill="none" stroke="var(--ink)" strokeWidth="1.5"/>}
    {!points.length&&<text x="400" y="150" textAnchor="middle">Residual history appears after results are exported.</text>}
    <text x="60" y="305">0</text><text x="770" y="305" textAnchor="end">{points.length?last:"—"} iterations</text>
  </svg></div>;
}
