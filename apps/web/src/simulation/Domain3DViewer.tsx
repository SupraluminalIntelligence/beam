import { useEffect, useMemo, useRef, useState } from "react";
import { AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DirectionalLight, DoubleSide, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Quaternion, Scene, SphereGeometry, Vector3, WebGLRenderer, type Material } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ahmedSurface, bodyBounds, type Domain3DCase, type Domain3DFields, type Domain3DMeshView } from "@beam/contracts";
import { wakeColor } from "./WakeViewer";

type Field="speed"|"pressure"|"ux";
type Surface={mesh:Mesh;colors:BufferAttribute;offset:number;count:number;name:string};
/** Tracer particles riding the streamlines; each advances at the local speed. */
type Tracers={points:BufferAttribute;lines:{at:Float32Array;length:Float32Array;speed:Float32Array}[];position:Float32Array;owner:Uint16Array;top:number};
const lut=(diverging:boolean)=>Array.from({length:256},(_,i)=>(wakeColor(i/255,diverging).match(/\d+/g)??["0","0","0"]).map(v=>Number(v)/255));
const palettes={sequential:lut(false),diverging:lut(true)};

/** Three.js view of a 3-D study: declared geometry, the checked snapped mesh, or sampled solver surfaces. */
export default function Domain3DViewer({config,meshView=null,fields=null,frames=null}:{config:Domain3DCase;meshView?:Domain3DMeshView|null;fields?:Domain3DFields|null;frames?:Float32Array|null}){
 const host=useRef<HTMLDivElement>(null),tracers=useRef<Tracers|null>(null),three=useRef<{renderer:WebGLRenderer;scene:Scene;camera:PerspectiveCamera;controls:OrbitControls;content:Group}|null>(null),surfaces=useRef<Surface[]>([]);
 const [field,setField]=useState<Field>("speed"),[playing,setPlaying]=useState(true),[speed,setSpeed]=useState(1),[frame,setFrame]=useState(0),[hidden,setHidden]=useState<string[]>([]),[failure,setFailure]=useState("");
 const ready=!!fields&&!!frames,position=useRef(0);
 const {min,max}=config.domain,centre=useMemo(()=>new Vector3((min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2),[config]),span=Math.max(max[0]-min[0],max[1]-min[1],max[2]-min[2]);
 // Scene units: centred on the domain and scaled to unit span for GPU precision.
 const local=(x:number,y:number,z:number)=>[(x-centre.x)/span,(y-centre.y)/span,(z-centre.z)/span];
 const uxRange=useMemo(()=>{if(!frames)return[0,1];let lo=Infinity,hi=-Infinity;for(let i=0;i<frames.length;i+=4){lo=Math.min(lo,frames[i]!);hi=Math.max(hi,frames[i]!);}return[lo,hi];},[frames]);
 const extent=field==="speed"?fields?.ranges.velocity??[0,1]:field==="pressure"?fields?.ranges.pressure??[0,1]:uxRange;
 useEffect(()=>{
  const el=host.current;if(!el)return;
  let renderer:WebGLRenderer;
  try{renderer=new WebGLRenderer({antialias:true,alpha:true});}catch{setFailure("WebGL is unavailable, so the 3D view cannot be drawn.");return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));el.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("role","img");renderer.domElement.setAttribute("aria-label","Interactive 3D fluid domain. Drag to orbit, right-drag to pan, scroll to zoom.");
  const scene=new Scene(),content=new Group();scene.add(content,new AmbientLight(0xffffff,1.5));
  const key=new DirectionalLight(0xffffff,2.4);key.position.set(2,-3,4);scene.add(key);
  const camera=new PerspectiveCamera(35,1,.005,50);camera.up.set(0,0,1);camera.position.set(.68,-1.12,.6);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.1;controls.maxDistance=10;
  const resize=()=>{const w=Math.max(1,el.clientWidth),h=Math.max(1,el.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};
  const observer=new ResizeObserver(resize);observer.observe(el);resize();
  let last=performance.now();
  renderer.setAnimationLoop(now=>{const dt=Math.min(.1,(now-last)/1000);last=now;advance(tracers.current,dt);controls.update();renderer.render(scene,camera);});
  three.current={renderer,scene,camera,controls,content};
  return()=>{observer.disconnect();renderer.setAnimationLoop(null);controls.dispose();clear(content);renderer.dispose();renderer.domElement.remove();three.current=null;};
 },[]);
 useEffect(()=>{
  const t=three.current;if(!t)return;
  clear(t.content);surfaces.current=[];tracers.current=null;
  const box=new LineSegments(new EdgesGeometry(new BoxGeometry((max[0]-min[0])/span,(max[1]-min[1])/span,(max[2]-min[2])/span)),new LineBasicMaterial({color:0x7d8b93}));t.content.add(box);
  const solid=new MeshStandardMaterial({color:0xd9e0e3,roughness:.75,metalness:0,side:DoubleSide});
  const edges=(points:number[],counts:number[],indices:number[],color:number)=>{const lines:number[]=[];let at=0;for(const n of counts){for(let k=0;k<n;k++){const a=indices[at+k]!,b=indices[at+(k+1)%n]!;lines.push(...local(points[3*a]!,points[3*a+1]!,points[3*a+2]!),...local(points[3*b]!,points[3*b+1]!,points[3*b+2]!));}at+=n;}const g=new BufferGeometry();g.setAttribute("position",new BufferAttribute(new Float32Array(lines),3));return new LineSegments(g,new LineBasicMaterial({color,transparent:true,opacity:.55}));};
  const geometry=(points:number[],triangles:number[])=>{const g=new BufferGeometry(),p=new Float32Array(points.length);for(let i=0;i<points.length;i+=3)p.set(local(points[i]!,points[i+1]!,points[i+2]!),i);g.setAttribute("position",new BufferAttribute(p,3));g.setIndex(triangles);g.computeVertexNormals();return g;};
  if(fields&&frames){
   let offset=0;
   for(const s of fields.surfaces){
    const g=geometry(s.points,s.triangles),n=s.points.length/3,colors=new BufferAttribute(new Float32Array(n*3),3);g.setAttribute("color",colors);
    const mesh=new Mesh(g,s.kind==="slice"?new MeshBasicMaterial({vertexColors:true,side:DoubleSide}):new MeshStandardMaterial({vertexColors:true,roughness:.8,side:DoubleSide}));
    mesh.name=s.name;t.content.add(mesh);surfaces.current.push({mesh,colors,offset,count:n,name:s.name});offset+=n;
   }
   if(fields.streamlines){const g=streamlineGroup(fields.streamlines,local);t.content.add(g.group);tracers.current=g.tracers;}
  }else if(meshView){
   for(const s of meshView.surfaces){
    const triangles:number[]=[];let at=0;for(const n of s.counts){for(let k=1;k+1<n;k++)triangles.push(s.indices[at]!,s.indices[at+k]!,s.indices[at+k+1]!);at+=n;}
    const g=new Group();g.name=s.name;
    g.add(new Mesh(geometry(s.points,triangles),s.kind==="wall"?solid:new MeshBasicMaterial({color:0x2a3a44,transparent:true,opacity:.35,side:DoubleSide,depthWrite:false})),edges(s.points,s.counts,s.indices,s.kind==="wall"?0x52616a:0x8fb3c6));
    t.content.add(g);
   }
  }else{
   for(const b of config.bodies){
    let mesh:Mesh;
    if(b.shape==="sphere"){mesh=new Mesh(new SphereGeometry(b.radius/span,48,24),solid);mesh.position.set(...local(...b.centre) as [number,number,number]);}
    else if(b.shape==="box"){mesh=new Mesh(new BoxGeometry((b.max[0]-b.min[0])/span,(b.max[1]-b.min[1])/span,(b.max[2]-b.min[2])/span),solid);mesh.position.set(...local((b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2) as [number,number,number]);}
    else if(b.shape==="ahmed"){const s=ahmedSurface(b),g=geometry(s.points,s.triangles).toNonIndexed();g.computeVertexNormals();mesh=new Mesh(g,solid);}
    else{const a=new Vector3(...b.start),e=new Vector3(...b.end),d=e.clone().sub(a);mesh=new Mesh(new CylinderGeometry(b.radius/span,b.radius/span,d.length()/span,48),solid);mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0,1,0),d.normalize()));const m=a.add(e).multiplyScalar(.5);mesh.position.set(...local(m.x,m.y,m.z) as [number,number,number]);}
    mesh.name=b.name;t.content.add(mesh);
   }
   for(const r of config.refinements??[])if(r.kind==="box"){const g=new LineSegments(new EdgesGeometry(new BoxGeometry((r.max[0]-r.min[0])/span,(r.max[1]-r.min[1])/span,(r.max[2]-r.min[2])/span)),new LineBasicMaterial({color:0xc79a5a,transparent:true,opacity:.7}));g.position.set(...local((r.min[0]+r.max[0])/2,(r.min[1]+r.max[1])/2,(r.min[2]+r.max[2])/2) as [number,number,number]);t.content.add(g);}
   for(const s of config.slices){
    // PlaneGeometry spans local x/y; rotating +z onto the normal maps local x to z for an x-normal plane.
    const size={x:[max[2]-min[2],max[1]-min[1]],y:[max[0]-min[0],max[2]-min[2]],z:[max[0]-min[0],max[1]-min[1]]}[s.normal];
    const plane=new Mesh(new PlaneGeometry(size[0]!/span,size[1]!/span),new MeshBasicMaterial({color:0x8fb3c6,transparent:true,opacity:.12,side:DoubleSide,depthWrite:false}));
    const p=local(centre.x,centre.y,centre.z);p[{x:0,y:1,z:2}[s.normal]]=local(s.offset,s.offset,s.offset)[{x:0,y:1,z:2}[s.normal]]!;plane.position.set(p[0]!,p[1]!,p[2]!);
    plane.quaternion.setFromUnitVectors(new Vector3(0,0,1),new Vector3(s.normal==="x"?1:0,s.normal==="y"?1:0,s.normal==="z"?1:0));
    plane.name=s.name;t.content.add(plane);
   }
  }
  for(const child of t.content.children)if(child.name)child.visible=!hidden.includes(child.name);
  paint();
 },[config,meshView,fields,frames]);
 // Frame the bodies rather than the whole domain: a car is small in its tunnel.
 const focus=config.bodies.length?JSON.stringify(config.bodies.map(bodyBounds)):"";
 useEffect(()=>{
  const t=three.current;if(!t||!config.bodies.length)return;
  const all=config.bodies.map(bodyBounds),lo=[0,1,2].map(i=>Math.min(...all.map(b=>b.min[i]!))),hi=[0,1,2].map(i=>Math.max(...all.map(b=>b.max[i]!)));
  const target=new Vector3(...local((lo[0]!+hi[0]!)/2,(lo[1]!+hi[1]!)/2,(lo[2]!+hi[2]!)/2) as [number,number,number]),size=Math.max(...[0,1,2].map(i=>hi[i]!-lo[i]!))/span;
  t.controls.target.copy(target);t.camera.position.copy(target.clone().add(new Vector3(.55,-.9,.45).normalize().multiplyScalar(Math.min(2,Math.max(.15,size*3.4)))));t.controls.update();
 },[focus]);
 useEffect(()=>{three.current?.content.children.forEach(c=>{if(c.name)c.visible=!hidden.includes(c.name);});},[hidden]);
 function paint(){
  if(!fields||!frames)return;
  const count=fields.times.length,f=Math.min(position.current,count-1),lo=Math.floor(f),hi=Math.min(count-1,lo+1),blend=f-lo,total=surfaces.current.reduce((n,s)=>n+s.count,0);
  const palette=field==="speed"?palettes.sequential:palettes.diverging,[a,b]=extent as [number,number],range=b-a||1;
  const value=(frameIndex:number,point:number)=>{const at=(frameIndex*total+point)*4;return field==="speed"?Math.hypot(frames[at]!,frames[at+1]!,frames[at+2]!):field==="pressure"?frames[at+3]!:frames[at]!;};
  for(const s of surfaces.current){
   const c=s.colors.array as Float32Array;
   for(let i=0;i<s.count;i++){const v=value(lo,s.offset+i)*(1-blend)+value(hi,s.offset+i)*blend,rgb=palette[Math.max(0,Math.min(255,Math.round((v-a)/range*255)))]!;c[3*i]=rgb[0]!;c[3*i+1]=rgb[1]!;c[3*i+2]=rgb[2]!;}
   s.colors.needsUpdate=true;
  }
 }
 useEffect(()=>{paint();},[frame,field,extent]);
 useEffect(()=>{position.current=0;setFrame(0);},[fields]);
 // A wind-tunnel view: streamlines over the body coloured by pressure; slices start hidden so they do not cover it.
 useEffect(()=>{if(fields?.streamlines){setHidden(fields.surfaces.filter(s=>s.kind==="slice").map(s=>s.name));setField("pressure");}},[fields]);
 useEffect(()=>{
  if(!ready||!playing)return;
  let last=performance.now(),handle=0;
  const tick=(now:number)=>{const count=fields!.times.length;position.current=(position.current+(now-last)/1000*8*speed)%Math.max(1,count-1);last=now;setFrame(position.current);handle=requestAnimationFrame(tick);};
  handle=requestAnimationFrame(tick);return()=>cancelAnimationFrame(handle);
 },[ready,playing,speed,fields]);
 const time=fields?(()=>{const f=Math.min(frame,fields.times.length-1),lo=Math.floor(f),hi=Math.min(fields.times.length-1,lo+1);return fields.times[lo]!+(fields.times[hi]!-fields.times[lo]!)*(f-lo);})():0;
 const layers=fields?[...fields.surfaces.map(s=>({name:s.name,kind:s.kind})),...(fields.streamlines?[{name:"streamlines",kind:"slice" as const}]:[])]:meshView?meshView.surfaces.map(s=>({name:s.name,kind:s.kind})):[...config.bodies.map(b=>({name:b.name,kind:"wall" as const})),...config.slices.map(s=>({name:s.name,kind:"slice" as const}))];
 const seek=(n:number)=>{position.current=n;setFrame(n);};
 const turbulence=config.turbulence.model==="laminar"?"laminar":"k-ω SST";
 return <div className="wake-viewer">
  <div className="sim-field-control">{ready&&<select aria-label="3D field" value={field} onChange={e=>setField(e.target.value as Field)}><option value="speed">Speed · m/s</option><option value="pressure">Gauge pressure · Pa</option><option value="ux">Velocity x · m/s</option></select>}<span>{ready?"Sampled slices and walls · interpolated snapshots":meshView?"Checked snappyHexMesh · slice cuts and snapped walls":`3-D fluid domain · pimpleFoam · ${turbulence}`}</span>
   <span className="sim-layers">{layers.map(l=><button key={l.name} aria-pressed={!hidden.includes(l.name)} onClick={()=>setHidden(h=>h.includes(l.name)?h.filter(n=>n!==l.name):[...h,l.name])}>{hidden.includes(l.name)?"□":"■"} {l.name}</button>)}</span></div>
  <div className="wake-viewport" ref={host}>{failure&&<div className="wake-empty">{failure}</div>}</div>
  {ready&&<><div className="wake-scale"><span>{extent[0]!.toPrecision(3)}</span><i style={{background:`linear-gradient(to right,${Array.from({length:9},(_,i)=>wakeColor(i/8,field!=="speed")).join(",")})`}}/><span>{extent[1]!.toPrecision(3)} {field==="pressure"?"Pa":"m/s"}</span><span>Colour range spans all saved times</span></div>
  <div className="wake-playback"><button aria-label={playing?"Pause playback":"Play playback"} onClick={()=>setPlaying(!playing)}>{playing?"Ⅱ Pause":"▶ Play"}</button><button aria-label="Restart playback" onClick={()=>seek(0)}>↺</button><input aria-label="Simulation time" type="range" min="0" max={fields!.times.length-1} step="0.01" value={frame} onChange={e=>{setPlaying(false);seek(Number(e.target.value));}}/><span>{time.toFixed(3)} s</span><select aria-label="Playback speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[.25,.5,1,2].map(v=><option key={v} value={v}>{v}×</option>)}</select></div></>}
  <div className="sim-figure-caption"><span>Fig. 1 — {ready?`Computed ${turbulence} flow on sampled surfaces`:meshView?`${meshView.surfaces.length} mesh surfaces`:`${config.region.name} · ${config.bodies.length} bodies · ${config.slices.length} slices`}</span><span>{ready?`${fields!.times.length} saved times`:`Domain ${(max[0]-min[0]).toPrecision(3)} × ${(max[1]-min[1]).toPrecision(3)} × ${(max[2]-min[2]).toPrecision(3)} m · z up`}</span></div>
 </div>;
}
/** Streamlines coloured by speed, plus tracer particles that the render loop advances. */
function streamlineGroup(lines:NonNullable<Domain3DFields["streamlines"]>,local:(x:number,y:number,z:number)=>number[]){
 const group=new Group();group.name="streamlines";
 const [lo,hi]=lines.range,range=hi-lo||1,palette=palettes.sequential,segments:number[]=[],colors:number[]=[];
 const paths=lines.lines.map(l=>{
  const n=l.speed.length,at=new Float32Array(n*3),length=new Float32Array(n);
  for(let i=0;i<n;i++){at.set(local(l.points[3*i]!,l.points[3*i+1]!,l.points[3*i+2]!),3*i);if(i)length[i]=length[i-1]!+Math.hypot(at[3*i]!-at[3*i-3]!,at[3*i+1]!-at[3*i-2]!,at[3*i+2]!-at[3*i-1]!);}
  for(let i=0;i+1<n;i++){segments.push(...at.subarray(3*i,3*i+6));for(const k of [i,i+1])colors.push(...palette[Math.max(0,Math.min(255,Math.round((l.speed[k]!-lo)/range*255)))]!);}
  return{at,length,speed:Float32Array.from(l.speed)};
 });
 const g=new BufferGeometry();g.setAttribute("position",new BufferAttribute(new Float32Array(segments),3));g.setAttribute("color",new BufferAttribute(new Float32Array(colors),3));
 group.add(new LineSegments(g,new LineBasicMaterial({vertexColors:true,transparent:true,opacity:.8})));
 // Three tracers per line, spread along it.
 const count=paths.length*3,position=new Float32Array(count),owner=new Uint16Array(count),points=new BufferAttribute(new Float32Array(count*3),3);
 paths.forEach((p,k)=>{for(let j=0;j<3;j++){owner[3*k+j]=k;position[3*k+j]=p.length[p.length.length-1]!*j/3;}});
 const dots=new BufferGeometry();dots.setAttribute("position",points);
 group.add(new Points(dots,new PointsMaterial({color:0xf2a93b,size:4,sizeAttenuation:false})));
 const tracers:Tracers={points,lines:paths,position,owner,top:hi||1};advance(tracers,0);
 return{group,tracers};
}
function advance(t:Tracers|null,dt:number){
 if(!t)return;
 const out=t.points.array as Float32Array;
 for(let i=0;i<t.position.length;i++){
  const l=t.lines[t.owner[i]!]!,n=l.speed.length,total=l.length[n-1]!;
  let s=t.position[i]!,k=0;while(k+2<n&&l.length[k+1]!<s)k++;
  // The fastest flow crosses the domain span in about 4 s; slower flow moves proportionally slower.
  s+=Math.max(.05,l.speed[k]!/t.top)*.25*dt;if(s>=total){s=0;k=0;}t.position[i]=s;
  while(k+2<n&&l.length[k+1]!<s)k++;
  const a=l.length[k]!,b=l.length[k+1]!,f=b>a?Math.min(1,Math.max(0,(s-a)/(b-a))):0;
  for(let c=0;c<3;c++)out[3*i+c]=l.at[3*k+c]!+(l.at[3*k+3+c]!-l.at[3*k+c]!)*f;
 }
 t.points.needsUpdate=true;
}
function clear(group:Group){
 for(const child of [...group.children]){
  child.traverse(o=>{const m=o as Mesh;m.geometry?.dispose();const mat=m.material as Material|Material[]|undefined;(Array.isArray(mat)?mat:mat?[mat]:[]).forEach(x=>x.dispose());});
  group.remove(child);
 }
}
