import { useEffect, useMemo, useRef, useState } from "react";
import { bodyLoop, bodyMeshSize, inside, pitchPoint, wakeGeometryAt, type CylinderCase, type PlanarCase, type PlanarMeshView, type WakeFields } from "@beam/contracts";
import { createWakeRenderer } from "./wakeRenderer";

type Field="vorticity"|"velocity"|"pressure";
const mix=(a:number[],b:number[],t:number)=>`rgb(${a.map((v,i)=>Math.round(v+(b[i]!-v)*t)).join(" ")})`;
export function wakeColor(t:number,diverging:boolean){
 t=Math.max(0,Math.min(1,t));
 return diverging?t<.5?mix([73,164,209],[16,24,31],t*2):mix([16,24,31],[245,173,86],(t-.5)*2):t<.5?mix([15,24,34],[44,115,146],t*2):mix([44,115,146],[215,237,222],(t-.5)*2);
}
export function WakeViewer({config,fields,frames,geometry=null,mesh=false,meshView=null}:{config:CylinderCase|PlanarCase;fields:WakeFields|null;frames:Float32Array|null;geometry?:Float32Array|null;mesh?:boolean;meshView?:PlanarMeshView|null}){
 const gpuCanvas=useRef<HTMLCanvasElement>(null),gpu=useRef<ReturnType<typeof createWakeRenderer>>(null),canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLDivElement>(null);
 const [field,setField]=useState<Field>("vorticity"),[playing,setPlaying]=useState(true),[speed,setSpeed]=useState(1),[frame,setFrame]=useState(0),[size,setSize]=useState([900,500]),[probe,setProbe]=useState<number|null>(null);
 const planar=config.geometry==="planar"?config:null;
 const D=planar?Math.max(.0001,...planar.bodies.map(b=>b.shape==="circle"?b.radius*2:Math.sqrt(Math.abs(b.vertices.reduce((s,p,i)=>{const q=b.vertices[(i+1)%b.vertices.length]!;return s+p[0]*q[1]-p[1]*q[0];},0)/2))),planar.bodies.length?0:planar.meshSize*10):(config as CylinderCase).diameter;
 const velocity=planar?Math.max(.001,...planar.boundaries.flatMap(b=>b.type==="velocity-inlet"?[Math.hypot(...b.velocity)]:[])):(config as CylinderCase).velocity;
 const reynolds=planar?velocity*D/planar.region.nu:(config as CylinderCase).reynolds;
 const bounds=planar?[Math.min(...planar.domain.vertices.map(p=>p[0]))/D,Math.max(...planar.domain.vertices.map(p=>p[0]))/D,Math.min(...planar.domain.vertices.map(p=>p[1]))/D,Math.max(...planar.domain.vertices.map(p=>p[1]))/D]:[-3,14,-4,4];
 const transform=(w:number,h:number)=>{const width=bounds[1]!-bounds[0]!,height=bounds[3]!-bounds[2]!,scale=Math.max(.01,Math.min((w-44)/width,(h-76)/height));return{scale,origin:(w-width*scale)/2-bounds[0]!*scale,originY:(h-height*scale)/2+bounds[3]!*scale};};
 const position=useRef(0),ready=!!fields&&!!frames;
 useEffect(()=>{position.current=0;setFrame(0);setPlaying(!matchMedia("(prefers-reduced-motion: reduce)").matches);},[fields]);
 useEffect(()=>{const el=host.current;if(!el)return;const observer=new ResizeObserver(([entry])=>{if(entry)setSize([entry.contentRect.width,entry.contentRect.height]);});observer.observe(el);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(!gpuCanvas.current||!fields)return;try{gpu.current=createWakeRenderer(gpuCanvas.current,fields,D);}catch{gpu.current=null;}return()=>{gpu.current?.dispose();gpu.current=null;};},[fields,D]);

 // Repeat the recorded sequence with an explicit restart, never fabricate a periodic closing frame.
 useEffect(()=>{if(!playing||!fields)return;let id=0,last=0;const tick=(now:number)=>{if(last){position.current+=(now-last)/1000*8*speed;if(position.current>=fields.times.length-1)position.current=0;setFrame(position.current);}last=now;id=requestAnimationFrame(tick);};id=requestAnimationFrame(tick);return()=>cancelAnimationFrame(id);},[playing,speed,fields]);
 const extent=field==="vorticity"?[-2*velocity/D,2*velocity/D]:fields?.ranges[field]??[0,1];
 const i0=Math.min(Math.floor(frame),(fields?.times.length??1)-1),i1=Math.min(i0+1,(fields?.times.length??1)-1),blend=frame-i0;
 const time=fields?fields.times[i0]!*(1-blend)+fields.times[i1]!*blend:0;
 const moving=useMemo(()=>fields?.motion&&geometry?wakeGeometryAt(fields,geometry,i0,i1,blend):null,[fields,geometry,i0,i1,blend]);
 const polygons=moving?.polygons??fields?.polygons;
 const bodyLoops=useMemo(()=>planar?.bodies.map(b=>bodyLoop(b,bodyMeshSize(planar,b)).map(p=>{const m=planar.motion;if(!m||m.body!==b.name)return p;const a=pitchPoint(p,m,ready?fields!.times[i0]!:0),z=pitchPoint(p,m,ready?fields!.times[i1]!:0);return[a[0]*(1-blend)+z[0]*blend,a[1]*(1-blend)+z[1]*blend] as [number,number];}))??[],[planar,fields,i0,i1,blend,ready]);

 const read=(i:number)=>{if(!fields||!frames)return 0;const offset=(f:number,k:number)=>frames[(f*fields.centres.length+i)*4+k]!;const at=(k:number)=>offset(i0,k)*(1-blend)+offset(i1,k)*blend;return field==="velocity"?Math.hypot(at(0),at(1)):at(field==="pressure"?2:3);};
 useEffect(()=>{
  const el=canvas.current,ctx=el?.getContext("2d");if(!el||!ctx)return;
  const w=size[0]!,h=size[1]!,ratio=Math.min(devicePixelRatio,2);el.width=Math.round(w*ratio);el.height=Math.round(h*ratio);ctx.scale(ratio,ratio);ctx.clearRect(0,0,w,h);if(!ready||!gpu.current){ctx.fillStyle="#090d10";ctx.fillRect(0,0,w,h);}
  const {scale,origin,originY}=transform(w,h);ctx.translate(origin,originY);ctx.scale(scale,-scale);
  if(ready&&gpu.current){const values=new Float32Array(fields!.centres.length);for(let i=0;i<values.length;i++)values[i]=read(i);gpu.current.draw(w,h,scale,origin,values,extent,field!=="velocity",originY,moving??undefined);}
  else if(ready){polygons?.forEach((polygon,i)=>{const path=new Path2D();polygon.forEach((v,j)=>j?path.lineTo(v[0]/D,v[1]/D):path.moveTo(v[0]/D,v[1]/D));path.closePath();const t=(read(i)-extent[0]!)/(extent[1]!-extent[0]!||1);ctx.fillStyle=wakeColor(t,field!=="velocity");ctx.fill(path);});}
  else if(!planar){
   ctx.strokeStyle="#243039";ctx.lineWidth=.6/scale;
   for(let x=-3;x<=14;x++){ctx.beginPath();ctx.moveTo(x,-4);ctx.lineTo(x,4);ctx.stroke();}
   for(let y=-4;y<=4;y++){ctx.beginPath();ctx.moveTo(-3,y);ctx.lineTo(14,y);ctx.stroke();}
   ctx.strokeStyle="#617785";ctx.setLineDash([.4,.12,.05,.12]);ctx.beginPath();ctx.moveTo(-3,0);ctx.lineTo(14,0);ctx.stroke();ctx.setLineDash([]);
   if(mesh){ctx.strokeStyle="#56646b";for(let i=0;i<96;i++){const a=i/96*Math.PI*2;ctx.beginPath();ctx.moveTo(.5*Math.cos(a),.5*Math.sin(a));ctx.lineTo(1.4*Math.cos(a),1.4*Math.sin(a));ctx.stroke();}for(let r=.5;r<1.4;r+=.09){ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();}}
  }
  if(planar){
   const draw=(points:[number,number][])=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p[0]/D,p[1]/D):ctx.moveTo(p[0]/D,p[1]/D));ctx.closePath();};
   ctx.strokeStyle="#65737c";ctx.lineWidth=1/scale;draw(planar.domain.vertices);ctx.stroke();
   if(mesh&&meshView){ctx.strokeStyle="#40515c";ctx.lineWidth=.5/scale;for(const p of meshView.polygons){draw(p);ctx.stroke();}}
   for(const loop of bodyLoops){draw(loop);ctx.fillStyle="#e5ebed";ctx.fill();ctx.strokeStyle="#8c989e";ctx.lineWidth=1/scale;ctx.stroke();}
   if(!ready){ctx.save();ctx.scale(1,-1);ctx.font=`${10/scale}px monospace`;ctx.fillStyle="#8fb3c6";ctx.textAlign="center";planar.domain.vertices.forEach((p,i)=>{const q=planar.domain.vertices[(i+1)%planar.domain.vertices.length]!;ctx.fillText(planar.domain.edgeBoundaries[i]!, (p[0]+q[0])/2/D,-(p[1]+q[1])/2/D-5/scale);});ctx.restore();}
  }else{ctx.fillStyle="#e5ebed";ctx.beginPath();ctx.arc(0,0,.5,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#8c989e";ctx.lineWidth=1/scale;ctx.stroke();}
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.font="10px monospace";ctx.fillStyle="#9caab2";ctx.fillText(`U ${velocity} m/s →`,22,28);ctx.fillText(`Re ${Number(reynolds.toPrecision(4))} · ${planar?"reference L":"D"} ${Number((D*1000).toPrecision(4))} mm`,22,h-20);
  ctx.textAlign="right";ctx.fillText(ready?`t ${time.toFixed(3)} s · ${planar?.motion?`pitch ${(planar.motion.meanAngleDegrees+planar.motion.amplitudeDegrees*Math.sin(2*Math.PI*planar.motion.frequencyHz*time)).toFixed(1)}°`:`tU/${planar?"L":"D"} ${(time*velocity/D).toFixed(1)}`}`:"No computed field",w-22,28);ctx.fillText(planar?"1 L":"1 D",w-40,h-20);ctx.beginPath();ctx.moveTo(w-40-scale,h-32);ctx.lineTo(w-40,h-32);ctx.strokeStyle="#9caab2";ctx.lineWidth=1;ctx.stroke();
 },[size,frame,polygons,field,config,ready,mesh,meshView,moving,bodyLoops]);
 const seek=(n:number)=>{position.current=n;setFrame(n);};
 return <div className="wake-viewer">
  <div className="sim-field-control"><select aria-label="Wake field" value={field} onChange={e=>setField(e.target.value as Field)}><option value="vorticity">Vorticity · 1/s</option><option value="velocity">Speed · m/s</option><option value="pressure">Gauge pressure · Pa</option></select><span>{ready?(moving?"Computed moving mesh · interpolated snapshots":"Computed transient · interpolated field"):planar?"2-D fluid domain · pimpleFoam":"2-D cylinder wake · pimpleFoam"}</span></div>
  <div className="wake-viewport" ref={host}><canvas ref={gpuCanvas} aria-hidden="true"/><canvas ref={canvas} aria-label={ready?`Animated ${field} in the fluid domain at ${time.toFixed(3)} seconds`:"Fluid domain geometry"} onMouseLeave={()=>setProbe(null)} onMouseMove={e=>{if(!fields)return;const box=e.currentTarget.getBoundingClientRect(),{scale,origin,originY}=transform(box.width,box.height);const x=(e.clientX-box.left-origin)/scale*D,y=-(e.clientY-box.top-originY)/scale*D;if(planar?(!inside([x,y],planar.domain.vertices)||bodyLoops.some(loop=>inside([x,y],loop))):x*x+y*y<D*D/4){setProbe(null);return;}let best=Infinity,cell=0;(moving?.centres??fields.centres).forEach((p,i)=>{const d=(p[0]-x)**2+(p[1]-y)**2;if(d<best){best=d;cell=i;}});setProbe(cell);}}/>
  {!ready&&!planar&&<div className="wake-empty">{mesh?"Checked body-fitted mesh · schematic preview":"Flow past a cylinder"}<span>{mesh?"Run the case to compute the time-dependent wake.":"Mesh, then Run. The wake appears here when the solve finishes."}</span></div>}
  </div>
  {ready&&<><div className="wake-scale"><span>{extent[0]!.toPrecision(3)}</span><i style={{background:`linear-gradient(to right,${Array.from({length:9},(_,i)=>wakeColor(i/8,field!=="velocity")).join(",")})`}}/><span>{extent[1]!.toPrecision(3)} {field==="vorticity"?"1/s · clipped":field==="velocity"?"m/s":"Pa"}</span><span>{probe!==null?`Cell ${probe+1} · ${read(probe).toPrecision(4)}`:"Hover to inspect"}</span></div>
  <div className="wake-playback"><button aria-label={playing?"Pause playback":"Play playback"} onClick={()=>setPlaying(!playing)}>{playing?"Ⅱ Pause":"▶ Play"}</button><button aria-label="Restart playback" onClick={()=>seek(0)}>↺</button><input aria-label="Simulation time" type="range" min="0" max={fields!.times.length-1} step="0.01" value={frame} onChange={e=>{setPlaying(false);seek(Number(e.target.value));}}/><span>{time.toFixed(2)} s</span><select aria-label="Playback speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[.25,.5,1,2].map(v=><option key={v} value={v}>{v}×</option>)}</select></div></>}
  <div className="sim-figure-caption"><span>Fig. 1 — {ready?"Solved velocity and vorticity":planar?`${planar.region.name} · ${planar.bodies.length} excluded bodies${meshView?` · ${meshView.polygons.length} cells`:""}`:"Fluid domain · cylinder excluded"}</span><span>{ready?`${fields!.times.length} saved times · loops from start`:planar?"Dimensions in SI · named boundaries":"Domain −5D to 15D · ±4D"}</span></div>
 </div>;
}
