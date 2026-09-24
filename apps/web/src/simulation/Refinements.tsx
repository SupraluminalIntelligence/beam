import type { MeshRefinement, PlanarCase } from "@beam/contracts";
export function Refinements({config:c,change}:{config:PlanarCase;change?:(c:PlanarCase)=>void}){
 const rows=c.refinements??[];
 const update=(index:number,r:MeshRefinement)=>change?.({...c,refinements:rows.map((old,i)=>i===index?r:old)});
 const add=(body?:string)=>{let n=1;while(rows.some(r=>r.name===`refinement${n}`))n++;const base={name:`refinement${n}`,size:c.meshSize/2,transition:c.meshSize};
  const xs=c.domain.vertices.map(p=>p[0]),ys=c.domain.vertices.map(p=>p[1]),x=(Math.min(...xs)+Math.max(...xs))/2,y=(Math.min(...ys)+Math.max(...ys))/2;
  change?.({...c,refinements:[...rows,body?{...base,kind:"body-distance",body,distance:c.meshSize}:{...base,kind:"box",min:[x-c.meshSize*2,y-c.meshSize*2],max:[x+c.meshSize*2,y+c.meshSize*2]}]});
 };
 const number=(label:string,value:number,set:(n:number)=>void)=><label className="sim-value"><span>{label.slice(label.indexOf(" ")+1)}</span><span><input aria-label={label} type="number" step="any" value={value} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))set(e.target.valueAsNumber);}}/><i>m</i></span></label>;
 return <><div className="sim-section-title">REFINEMENT <span>{rows.length}</span></div>
  {!rows.length&&<p>Uniform background size. Add a body band or a box to resolve selected areas.</p>}
  {rows.map((r,i)=><div key={i}>
   <div className="sim-section-title">{r.name}{change&&<button aria-label={`Remove ${r.name}`} onClick={()=>change({...c,refinements:rows.filter((_,j)=>i!==j)})}>×</button>}</div>
   <p>{r.kind==="body-distance"?`${r.body} · surface distance ${r.distance} m`:`Box (${r.min.join(", ")}) → (${r.max.join(", ")}) m`}</p>
   {change?<>{number(`${r.name} size`,r.size,n=>update(i,{...r,size:n}))}{number(`${r.name} transition`,r.transition,n=>update(i,{...r,transition:n}))}
    {r.kind==="body-distance"?number(`${r.name} distance`,r.distance,n=>update(i,{...r,distance:n})):(["min","max"] as const).map(edge=><div key={edge}>{([0,1] as const).map(k=><div key={k}>{number(`${r.name} ${edge} ${k===0?"x":"y"}`,r[edge][k],n=>update(i,{...r,[edge]:k===0?[n,r[edge][1]]:[r[edge][0],n]}))}</div>)}</div>)}
   </>:<p>Target {r.size} m · transition {r.transition} m</p>}
  </div>)}
  {change&&rows.length<32&&<><select aria-label="Add body refinement" value="" onChange={e=>{if(e.target.value)add(e.target.value);}}><option value="">Refine around a body…</option>{c.bodies.map(b=><option key={b.name} value={b.name}>{b.name}</option>)}</select><button className="sim-text-button" onClick={()=>add()}>＋ Add refinement box</button><p>Sizes are targets, not maximum edge lengths. Mesh previews show the generated cells. Refinement requires a new mesh and run.</p></>}
 </>;
}
