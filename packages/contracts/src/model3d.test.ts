import { expect, it } from "vitest";
import { normalizeModel, readModel, encodeStl, decodeModel, measureModel, closeAndOrient, weld, modelMatches, placement, placeSurface, guessUnits, turnMatrix, type Model3D } from "./model3d.ts";
import { Domain3DCase, referenceDrag, windsorTunnel, defaultAhmedTunnel, AHMED, ahmedSurface, bodyBounds, frontalArea, estimateDomain3dCells, insideBody, locationInMesh, modelInputs, modelWindTunnel, MODEL_TUNNEL_CELL_TARGET, meshKey, simulationOutputs, simulationMeshInputs, type Body3D } from "./simulation.ts";
import { ProcessJobSpec } from "./compute.ts";

// Unit cube, outward-facing, as 12 triangles over 8 corners.
const corners=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
const cube=(size:[number,number,number]=[1,1,1],at=[0,0,0])=>({points:corners.flatMap(c=>c.map((v,i)=>v*size[i]!+at[i]!)),triangles:quads.flatMap(([a,b,c,d])=>[a!,b!,c!,a!,c!,d!])});
const asciiStl=(s:{points:number[];triangles:number[]})=>`solid cube\n${Array.from({length:s.triangles.length/3},(_,t)=>` facet normal 0 0 0\n  outer loop\n${[0,1,2].map(k=>{const i=s.triangles[3*t+k]!;return`   vertex ${s.points[3*i]} ${s.points[3*i+1]} ${s.points[3*i+2]}`;}).join("\n")}\n  endloop\n endfacet`).join("\n")}\nendsolid cube\n`;
const text=(s:string)=>new TextEncoder().encode(s);

it("reads binary STL, ASCII STL and OBJ into the same closed surface",()=>{
 const binary=normalizeModel(encodeStl(cube([2,1,.5])),"box.stl").measures;
 const ascii=normalizeModel(text(asciiStl(cube([2,1,.5]))),"box.STL").measures;
 const obj=normalizeModel(text(`# box\n${corners.map(c=>`v ${c[0]!*2} ${c[1]} ${c[2]!*.5}`).join("\n")}\nvn 0 0 1\n${quads.map(q=>`f ${q.map(i=>`${i+1}//1`).join(" ")}`).join("\n")}\n`),"box.obj").measures;
 for(const m of [binary,ascii,obj]){
  expect(m.triangles).toBe(12);expect(m.shells).toBe(1);
  expect(m.min).toEqual([0,0,0]);expect(m.max).toEqual([2,1,.5]);
  expect(m.volume).toBeCloseTo(1,6);expect(m.area).toBeCloseTo(2*(2+1+.5),6);
  // Silhouettes along x, y and z: 1 × 0.5, 2 × 0.5 and 2 × 1, to raster accuracy.
  expect(m.projectedArea[0]).toBeCloseTo(.5,2);expect(m.projectedArea[1]).toBeCloseTo(1,2);expect(m.projectedArea[2]).toBeCloseTo(2,2);
 }
 // OBJ negative indices refer back from the latest vertex.
 expect(readModel(text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n"),"t.obj").triangles).toEqual(Uint32Array.from([0,1,2]));
});
it("rejects open surfaces, unsupported formats and oversized models",()=>{
 const open=cube();open.triangles=open.triangles.slice(0,-6);
 expect(()=>normalizeModel(encodeStl(open),"open.stl")).toThrow(/not closed: 4 edges/);
 expect(()=>normalizeModel(text("ISO-10303-21;"),"part.step")).toThrow(/Import STL or OBJ/);
 expect(()=>normalizeModel(text("solid x\nendsolid x\n"),"empty.stl")).toThrow(/no triangles/);
 const huge=new Uint8Array(84+50*300_000);new DataView(huge.buffer).setUint32(80,300_000,true);
 expect(()=>readModel(huge,"big.stl")).toThrow(/limit is 200,000/);
});
it("closes float32 seams, T-junctions and small gaps, and says so",()=>{
 const c=cube();
 // Top face split at the middle of one edge (a T-junction against the side face), and one corner
 // of another triangle nudged 1e-9 (float32 rounding) and one 1e-4 (a sliver gap).
 const m=c.points.length/3,top=[4,m,7,m,5,6,m,6,7];c.points.push(.5,0,1);
 const seam=c.points.length/3;c.points.push(1+1e-9,0,0);
 const nudged=c.points.length/3;c.points.push(-1e-4,1,1e-4);
 const triangles=c.triangles.slice(0,6).concat(top,c.triangles.slice(12));
 const at=(a:number,b:number,cc:number)=>triangles.findIndex((_,i)=>i%3===0&&triangles[i]===a&&triangles[i+1]===b&&triangles[i+2]===cc);
 triangles[at(0,1,5)+1]=seam;triangles[at(3,0,4)]=nudged;
 const {measures}=normalizeModel(encodeStl({points:c.points,triangles}),"seams.stl");
 expect(measures.volume).toBeCloseTo(1,3);expect(measures.shells).toBe(1);
 expect(measures.repairs).toMatchObject({tJunctions:1,gaps:1});expect(measures.repairs!.widestGap).toBeLessThan(1e-3);
 // A clean model reports no repairs.
 expect(normalizeModel(encodeStl(cube()),"clean.stl").measures.repairs).toBeUndefined();
});
it("orients every shell outward, whatever order the file lists triangles in",()=>{
 // Flip two faces and turn a second cube inside out.
 const a=cube(),b=cube([1,1,1],[3,0,0]),triangles=[...a.triangles,...b.triangles.map(i=>i+8)];
 for(const t of [0,5])[triangles[3*t+1],triangles[3*t+2]]=[triangles[3*t+2]!,triangles[3*t+1]!];
 for(let t=12;t<24;t++)[triangles[3*t+1],triangles[3*t+2]]=[triangles[3*t+2]!,triangles[3*t+1]!];
 const {surface,shells}=closeAndOrient(weld({points:Float64Array.from([...a.points,...b.points]),triangles:Uint32Array.from(triangles)}));
 const m=measureModel(surface,shells);
 expect(shells).toBe(2);expect(m.volume).toBeCloseTo(2,9);
 // Round trip through the stored binary STL keeps the same measurements.
 expect(modelMatches(measureModel(decodeModel(encodeStl(surface))),{...m,assetId:"a",file:"two.stl",sha256:"x".repeat(44)})).toBe(true);
});

const model=(m:ReturnType<typeof normalizeModel>["measures"],file="car.stl"):Model3D=>({assetId:"kg2abc",file,sha256:"q".repeat(44),triangles:m.triangles,min:m.min,max:m.max,area:m.area,volume:m.volume,projectedArea:m.projectedArea});
// A 4.5 × 1.8 × 1.4 m car-sized box drawn in millimetres with y up, as many CAD and game exports are.
const yUp=model(normalizeModel(encodeStl(cube([4500,1400,1800],[-2250,0,-900])),"car.stl").measures);

it("places a model by quarter turns, scale and its front-bottom-centre",()=>{
 expect(guessUnits(yUp)).toBe("mm");
 expect(turnMatrix([90,0,0])).toEqual([[1,0,0],[0,0,-1],[0,1,0]]);
 const body:Body3D={name:"car",shape:"model",model:yUp,scale:.001,rotation:[90,0,0],position:[1,0,.1],boundary:"carWall"};
 const b=bodyBounds(body);
 [[1,-.9,.1],[5.5,.9,1.5]].forEach((p,k)=>p.forEach((v,i)=>expect((k?b.max:b.min)[i]).toBeCloseTo(v,9)));
 // The silhouette facing +x is the native x view: 1.4 × 1.8 m.
 expect(frontalArea(body)).toBeCloseTo(1.4*1.8,2);
 // Turned a quarter about z, the car faces the flow side-on.
 expect(frontalArea({...body,rotation:[90,0,90]} as Body3D)).toBeCloseTo(4.5*1.4,1);
 const world=placeSurface({...body,rotation:[90,0,0]} as Extract<Body3D,{shape:"model"}>,decodeModel(encodeStl(cube([4500,1400,1800],[-2250,0,-900]))));
 const placed=measureModel(world);
 expect(placed.volume).toBeCloseTo(4.5*1.4*1.8,6);
 placed.min.forEach((v,i)=>expect(v).toBeCloseTo(b.min[i]!,5));
 expect(insideBody(body,[3,0,.8])).toBe(true);expect(insideBody(body,[3,0,1.6])).toBe(false);
});
it("builds a valid tunnel around an imported car within the local budget",()=>{
 const c=modelWindTunnel(yUp,{scale:.001,rotation:[90,0,0]});
 expect(Domain3DCase.safeParse(c).success).toBe(true);
 const car=c.bodies[0]!,b=bodyBounds(car),level=c.refinements!.find(r=>r.kind==="body")!.level;
 expect(estimateDomain3dCells(c).estimated).toBeLessThanOrEqual(MODEL_TUNNEL_CELL_TARGET);
 // Nose at the origin, 2.5 surface cells above the ground, inside a ±100 m tunnel.
 expect(b.min[0]).toBeCloseTo(0,9);expect(b.min[2]).toBeCloseTo(2.5*c.meshSize/2**level,9);
 expect(c.domain.faces.zMin).toBe("ground");expect(c.domain.max[0]).toBeLessThanOrEqual(100);
 expect(insideBody(car,locationInMesh(c),c.meshSize)).toBe(false);
 // Free stream centres the model instead.
 const air=modelWindTunnel(yUp,{scale:.001,rotation:[90,0,0],ground:false}),a=bodyBounds(air.bodies[0]!);
 expect(air.boundaries.some(x=>x.name==="ground")).toBe(false);expect(a.min[2]+a.max[2]).toBeCloseTo(0,9);
 // Read in metres by mistake, the same file is 4.5 km long and has no tunnel.
 expect(()=>modelWindTunnel(yUp,{scale:1})).toThrow(/Check its units/);
});
it("resolves the Ahmed body as an imported surface like the parametric one",()=>{
 const ahmed=ahmedSurface({name:"a",shape:"ahmed",nose:[0,0,0],scale:1,slantDegrees:25,boundary:"w"});
 const m=model(normalizeModel(encodeStl(ahmed),"ahmed.stl").measures,"ahmed.stl");
 expect(m.max[0]-m.min[0]).toBeCloseTo(AHMED.length,5);
 expect(m.projectedArea[0]).toBeCloseTo(.112,2);
 const c=modelWindTunnel(m,{scale:1});
 expect(c.refinements!.find(r=>r.kind==="body")!.level).toBeGreaterThanOrEqual(2);
 expect(c.meshSize).toBeLessThan(.2);
});
it("sends each imported surface to the mesh job and keys the mesh on it",()=>{
 const c=modelWindTunnel(yUp,{scale:.001,rotation:[90,0,0]});
 expect(modelInputs(c)).toEqual([{assetId:"kg2abc",path:"models/model.stl"}]);
 expect(simulationMeshInputs(c)).toEqual(modelInputs(c));
 const job=(inputs:{assetId:string;path:string}[])=>ProcessJobSpec.safeParse({version:1,kind:"process",title:"car",executable:"beam:openfoam",args:[],inputs,outputs:simulationOutputs("mesh",c),timeoutSeconds:60,simulation:{caseId:"c",revision:1,stage:"mesh",config:c}});
 expect(job(modelInputs(c)).success).toBe(true);
 expect(job([]).success).toBe(false);
 expect(job([{assetId:"kg2abc",path:"models/other.stl"}]).success).toBe(false);
 const moved={...c,bodies:[{...c.bodies[0]!,model:{...yUp,assetId:"other",sha256:"z".repeat(44)}}]} as typeof c;
 expect(meshKey(moved)).not.toBe(meshKey(c));
 expect(meshKey({...c,duration:2})).toBe(meshKey(c));
});
it("compares with a stated reference drag, or the Ahmed measurement",()=>{
 expect(referenceDrag(defaultAhmedTunnel)).toEqual({cd:.285,area:null,source:"Ahmed 1984"});
 const windsor=windsorTunnel(model(normalizeModel(encodeStl(cube([1.044,.475,.389],[-.56,0,-.1945])),"windsor_1.stl").measures,"windsor_1.stl"));
 expect(referenceDrag(windsor)).toEqual({cd:.3225,area:.112,source:"WindsorML run 1 · WMLES"});
 // y up in the file, z up in the tunnel; the reference never changes the mesh.
 const b=bodyBounds(windsor.bodies[0]!);expect(b.max[2]-b.min[2]).toBeCloseTo(.475,5);
 const {reference:_,...plain}=windsor;expect(meshKey(plain as typeof windsor)).toBe(meshKey(windsor));
 expect(Domain3DCase.safeParse({...windsor,reference:{cd:.3,area:0,source:"x"}}).success).toBe(false);
});
