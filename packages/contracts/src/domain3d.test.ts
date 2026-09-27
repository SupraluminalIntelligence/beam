import { expect, it } from "vitest";
import { Domain3DCase, defaultDomain3d, estimateDomain3dCells, locationInMesh, insideBody, SimulationCase, meshKey, simulationOutputs, meshInputPath, Domain3DFields, decodeDomain3dFrames, type Domain3DCase as Case } from "./simulation.ts";
import { ProcessJobSpec } from "./compute.ts";
const issues=(c:unknown)=>{const r=Domain3DCase.safeParse(c);return r.success?[]:r.error.issues.map(i=>i.message);};
const clone=()=>structuredClone(defaultDomain3d) as Case;
it("accepts the sphere example and estimates a bounded mesh",()=>{
 expect(SimulationCase.parse(defaultDomain3d).geometry).toBe("domain3d");
 const e=estimateDomain3dCells(defaultDomain3d);
 expect(e.background).toBe(24000);expect(e.estimated).toBeGreaterThan(e.background);expect(e.estimated).toBeLessThan(250000);
});
it("rejects bodies that crowd faces, each other or the resolution",()=>{
 const near=clone();near.bodies[0]={...near.bodies[0]!,shape:"sphere",centre:[0,0,.085],radius:.01} as Case["bodies"][number];
 expect(issues(near).join()).toMatch(/two background cells/);
 const coarse=clone();coarse.refinements=[];(coarse.bodies[0] as {radius:number}).radius=.015;
 expect(issues(coarse).join()).toMatch(/fewer than four cells/);
 const pair=clone();pair.bodies.push({name:"box",shape:"box",min:[.025,-.01,-.01],max:[.04,.01,.01],boundary:"sphereWall"});pair.refinements!.push({name:"boxSurface",kind:"body",body:"box",level:2,distance:0});
 expect(issues(pair).join()).toMatch(/separated/);
});
it("requires boundaries to cover faces and bodies exactly",()=>{
 const c=clone();c.domain.faces.zMax="lid";
 expect(issues(c).join()).toMatch(/exactly cover/);
 const shared=clone();shared.bodies[0]!.boundary="sides";
 expect(issues(shared).join()).toMatch(/wall|separate/);
});
it("enforces the local cell budget before meshing",()=>{
 const fine=clone();fine.meshSize=.002;
 expect(issues(fine).join()).toMatch(/Background mesh/);
 const refined=clone();refined.refinements=[{name:"all",kind:"box",min:[-.1,-.1,-.1],max:[.5,.1,.1],level:3}];refined.meshSize=.01;
 expect(issues(refined).join()).toMatch(/Estimated/);
});
it("keeps mesh identity for physics edits and uses archive snapshots",()=>{
 const c=clone();
 expect(meshKey({...c,turbulence:{model:"laminar"},duration:5})).toBe(meshKey(c));
 expect(meshKey({...c,meshSize:.008})).not.toBe(meshKey(c));
 expect(simulationOutputs("mesh",c)).toEqual(["report.json","mesh.tar.gz","mesh-view.json"]);
 const job={version:1,kind:"process",title:"3D",executable:"beam:openfoam",args:[],inputs:[{assetId:"a",path:meshInputPath(c)}],outputs:simulationOutputs("solve",c),timeoutSeconds:600,simulation:{caseId:"c",revision:1,stage:"solve",meshJobId:"m",config:c}};
 expect(ProcessJobSpec.safeParse(job).success).toBe(true);
 expect(ProcessJobSpec.safeParse({...job,inputs:[{assetId:"a",path:"mesh-input.json"}]}).success).toBe(false);
});
it("finds a fluid seed point outside every body",()=>{
 const c=clone(),p=locationInMesh(c);
 expect(c.bodies.some(b=>insideBody(b,p))).toBe(false);
 expect(p.every((v,i)=>v>c.domain.min[i]!&&v<c.domain.max[i]!)).toBe(true);
});
it("validates 3D playback addressing and byte counts",()=>{
 const fields=Domain3DFields.parse({version:1,kind:"domain3d-surfaces",encoding:"float32-le",times:[.1,.2],surfaces:[{name:"s",kind:"slice",points:[0,0,0,1,0,0,0,1,0],triangles:[0,1,2]}],ranges:{velocity:[0,1],pressure:[-1,1]}});
 expect(decodeDomain3dFrames(new ArrayBuffer(2*3*16),fields).length).toBe(24);
 expect(()=>decodeDomain3dFrames(new ArrayBuffer(16),fields)).toThrow();
 expect(Domain3DFields.safeParse({...fields,surfaces:[{name:"s",kind:"slice",points:[0,0,0],triangles:[0,1,2]}]}).success).toBe(false);
});
