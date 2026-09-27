import { expect, it, vi } from "vitest";
import { decodeModel, measureModel, windsorTunnel, bodyBounds, frontalArea, WINDSOR } from "@beam/contracts";
import { bundledModel, importModelFile } from "./modelImport";

it("normalizes an OBJ in the browser and uploads only the binary STL",async()=>{
 const obj="v 0 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 0\nv 0 0 1\nv 2 0 1\nv 2 1 1\nv 0 1 1\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n";
 let uploaded:Uint8Array|null=null;
 vi.stubGlobal("fetch",vi.fn(async(_:string,init:RequestInit)=>{uploaded=new Uint8Array(await (init.body as Blob).arrayBuffer());return new Response(JSON.stringify({storageId:"blob"}));}));
 const stage=vi.fn(async()=>({assetId:"asset",sha256:"n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="}));
 const model=await importModelFile(new File([obj],"block.obj"),{uploadUrl:async()=>"https://storage.test/upload",stage});
 expect(stage).toHaveBeenCalledWith("blob");
 expect(model).toMatchObject({assetId:"asset",file:"block.obj",triangles:12,min:[0,0,0],max:[2,1,1]});
 expect(model.volume).toBeCloseTo(2,9);
 expect(uploaded!.byteLength).toBe(84+50*12);
 expect(measureModel(decodeModel(uploaded!)).volume).toBeCloseTo(2,6);
 vi.unstubAllGlobals();
});

it("loads the bundled Windsor body and sets up its tunnel with the published drag",async()=>{
 const {readFile}=await import("node:fs/promises");
 const gz=await readFile(new URL("./assets/windsor_1.stl.gz",import.meta.url));
 vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>url==="windsor.gz"?new Response(gz):new Response(JSON.stringify({storageId:"blob"}),{status:init?.method==="POST"?200:404})));
 const file=await bundledModel("windsor.gz",WINDSOR.file);
 expect(file.size).toBe(5_599_784);
 const model=await importModelFile(file,{uploadUrl:async()=>"https://storage.test/upload",stage:async()=>({assetId:"asset",sha256:"n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="})});
 expect(model.repairs?.tJunctions).toBeGreaterThan(0);
 const study=windsorTunnel(model),body=study.bodies[0]!,b=bodyBounds(body);
 // 1,044 mm long and 389 mm wide; 475 mm tall with its pins, standing upright with flow along +x.
 expect(b.max[0]-b.min[0]).toBeCloseTo(1.044,3);expect(b.max[1]-b.min[1]).toBeCloseTo(.389,3);expect(b.max[2]-b.min[2]).toBeCloseTo(.475,3);
 expect(frontalArea(body)).toBeCloseTo(.118,3);
 expect(study.reference).toEqual({cd:.3225,area:.112,source:"WindsorML run 1 · WMLES"});
 vi.unstubAllGlobals();
});
