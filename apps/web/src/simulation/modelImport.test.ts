import { expect, it, vi } from "vitest";
import { decodeModel, measureModel } from "@beam/contracts";
import { importModelFile } from "./modelImport";

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
