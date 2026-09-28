import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signedArea, type Point2 } from "@beam/contracts";
import { meshPolygons } from "./cylinder.ts";
/** Export actual solver-written coordinates with stable cell/vertex addressing. */
export async function exportMovingMesh(dir:string,times:number[],reference:Point2[][],faces:string,owners:string){
 const vertices:Point2[]=[],lookup=new Map<string,number>();
 const cellVertices=reference.map(poly=>poly.map(p=>{const key=p.map(v=>v.toPrecision(12)).join(",");let id=lookup.get(key);if(id===undefined){id=vertices.length;lookup.set(key,id);vertices.push(p);}return id;}));
 if(vertices.length>6500||reference.some(p=>p.length!==3))throw new Error("Unsupported moving mesh topology");
 const bytes=Buffer.alloc(times.length*vertices.length*8);if(bytes.length>20e6)throw new Error("Moving mesh exceeds playback budget");
 let minArea=Infinity;
 for(let frame=0;frame<times.length;frame++){
  const pointText=await readFile(join(dir,String(times[frame]),"polyMesh/points"),"utf8");
  const polys=meshPolygons(pointText,faces,owners,reference.length);
  for(let i=0;i<polys.length;i++){
   const p=polys[i]!,area=signedArea(p),initial=signedArea(reference[i]!);
   if(!Number.isFinite(area)||area*initial<=0||Math.abs(area)<Math.abs(initial)*.02)throw new Error(`Collapsed or inverted moving cell at t=${times[frame]}`);
   minArea=Math.min(minArea,Math.abs(area));
   for(let j=0;j<3;j++){const id=cellVertices[i]![j]!;for(let k=0;k<2;k++)bytes.writeFloatLE(p[j]![k]!,((frame*vertices.length+id)*2+k)*4);}
  }
 }
 await writeFile(join(dir,"geometry.bin"),bytes);
 return{manifest:{vertexCount:vertices.length,cellVertices},checkedFrames:times.length,minArea};
}
