import { expect,it } from "vitest";
import { defaultPlanar, type WakeFields } from "@beam/contracts";
import { comparePlanarFields } from "./compare.ts";
const rect=(a:number,b:number):[number,number][]=>[[a,0],[b,0],[b,1],[a,1]];
const result=(polygons:[number,number][][],times:number[],speeds:number[][])=>({config:defaultPlanar,fields:{version:1,kind:"planar-flow",encoding:"float32-le",polygons,centres:polygons.map(p=>[p.reduce((s,v)=>s+v[0],0)/4,.5]),times,ranges:{velocity:[0,4],pressure:[10,10],vorticity:[0,0]}} as WakeFields,frames:new Float32Array(speeds.flatMap(row=>row.flatMap(v=>[v,0,10,0])))});
it("compares area-weighted values on different meshes at a common interpolated time",()=>{
 const a=result([rect(0,.25),rect(.25,1)],[1,3],[[0,2],[2,4]]);
 const b=result([rect(0,.25),rect(.25,.5),rect(.5,.75),rect(.75,1)],[2],[[1,3,3,3]]);
 const c=comparePlanarFields(a,b);
 expect(c.physicalTimeSeconds).toBe(2);expect(c.baseline.meanSpeedMS).toBe(2.5);expect(c.candidate.meanSpeedMS).toBe(2.5);
 expect(c.change.meanSpeedMS).toBe(0);expect(c.change.meanPressurePa).toBe(0);expect(c.change.meanKineticEnergyDensityJPerM3).toBe(0);
 expect(c.baseline.meanKineticEnergyDensityJPerM3).toBe(3500);
 expect(()=>comparePlanarFields(a,{...b,config:{...defaultPlanar,region:{...defaultPlanar.region,nu:.0002}}})).toThrow(/unchanged/);
 expect(()=>comparePlanarFields(a,{...b,fields:{...b.fields,times:[4]}})).toThrow(/overlapping/);
});
it("uses the moving cell areas for comparison and rejects missing coordinates",()=>{
 const fields={version:1,kind:"planar-flow",encoding:"float32-le",times:[1,2],centres:[[1/3,1/3],[4/3,1/3]],polygons:[[[0,0],[1,0],[0,1]],[[1,0],[2,0],[1,1]]],motion:{vertexCount:6,cellVertices:[[0,1,2],[3,4,5]]},ranges:{velocity:[0,2],pressure:[0,0],vorticity:[0,0]}} as WakeFields;
 const config={...defaultPlanar,motion:{kind:"pitch" as const,body:"frontCylinder",pivot:[0,0] as [number,number],meanAngleDegrees:0,amplitudeDegrees:5,frequencyHz:1}};
 const run={config,fields,frames:new Float32Array([0,0,0,0,2,0,0,0,0,0,0,0,2,0,0,0]),geometry:new Float32Array([0,0,1,0,0,1,1,0,2,0,1,1,0,0,1,0,0,1,1,0,3,0,1,1])};
 expect(comparePlanarFields(run,run).baseline.meanSpeedMS).toBeCloseTo(4/3);
 expect(()=>comparePlanarFields({...run,geometry:undefined},run)).toThrow(/coordinates/);
});
