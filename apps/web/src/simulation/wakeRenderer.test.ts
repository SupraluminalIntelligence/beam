import { expect,it } from "vitest";
import { wakeDisplayMesh } from "./wakeRenderer";
import type { WakeFields } from "@beam/contracts";
it("shares corner values across cells without introducing centre peaks",()=>{
 const f={centres:[[.5,.5],[1.5,.5]],polygons:[[[0,0],[1,0],[1,1],[0,1]],[[1,0],[2,0],[2,1],[1,1]]]} as WakeFields;
 const m=wakeDisplayMesh(f,1);
 expect(m.indices).toHaveLength(12);
 expect(m.samples).toHaveLength(6); // six unique corners, no independent centre anchors
 const shared=m.samples.filter(s=>s.length===2);expect(shared).toHaveLength(2);
 for(const row of m.samples){expect(row.reduce((s,p)=>s+p.weight,0)).toBeCloseTo(1);expect(row.every(p=>p.weight>0)).toBe(true);}
 for(const row of shared)expect(row.map(p=>p.weight)).toEqual([.5,.5]);
 expect(Math.max(...m.indices)).toBeLessThan(m.samples.length);
});
it("keeps a triangle's interior within its reconstructed corner range",()=>{
 const f={centres:[[1/3,1/3],[2/3,2/3]],polygons:[[[0,0],[1,0],[0,1]],[[1,0],[1,1],[0,1]]]} as WakeFields;
 const m=wakeDisplayMesh(f,1),raw=[0,100];
 const nodal=m.samples.map(row=>row.reduce((sum,p)=>sum+raw[p.cell]!*p.weight,0));
 expect(m.samples).toHaveLength(4);
 expect(m.indices).toHaveLength(6);
 [0,50,50,100].forEach((value,i)=>expect(nodal[i]).toBeCloseTo(value));
 // Both triangles use the same endpoint values on their shared edge.
 const first=Array.from(m.indices.slice(0,3)),second=Array.from(m.indices.slice(3));
 expect(first.filter(i=>second.includes(i))).toEqual([1,2]);
 for(let i=0;i<m.indices.length;i+=3){
  const corners=Array.from(m.indices.slice(i,i+3)).map(id=>nodal[id]!);
  for(const weights of [[1/3,1/3,1/3],[.1,.2,.7]]){
   const interpolated=corners.reduce((sum,value,j)=>sum+value*weights[j]!,0);
   expect(interpolated).toBeGreaterThanOrEqual(Math.min(...corners));
   expect(interpolated).toBeLessThanOrEqual(Math.max(...corners));
  }
 }
 expect(raw).toEqual([0,100]);
});
it("moves shared vertices and updates nodal weights on a deforming mesh",async()=>{
 const {moveWakeDisplayMesh}=await import("./wakeRenderer");
 const f={centres:[[1/3,1/3],[2/3,2/3]],polygons:[[[0,0],[1,0],[0,1]],[[1,0],[1,1],[0,1]]],motion:{vertexCount:4,cellVertices:[[0,1,2],[1,3,2]]}} as WakeFields;
 const mesh=wakeDisplayMesh(f,1),indices=Array.from(mesh.indices);
 moveWakeDisplayMesh(mesh,new Float32Array([0,0,2,0,0,1,2,2]),[[2/3,1/3],[4/3,1]],1);
 expect(Array.from(mesh.vertices)).toEqual([0,0,2,0,0,1,2,2]);expect(Array.from(mesh.indices)).toEqual(indices);
 for(const row of mesh.samples)expect(row.reduce((s,p)=>s+p.weight,0)).toBeCloseTo(1);
 expect(mesh.samples[1]![0]!.weight).not.toBeCloseTo(.5);
});
