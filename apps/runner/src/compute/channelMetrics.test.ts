import { expect, it } from "vitest";
import { defaultChannel, type ChannelCase } from "@beam/contracts";
import { channelPatches, channelResults, labelList, patchRanges, patchValues } from "./channelMetrics.ts";

const header="FoamFile { version 2.0; format ascii; class labelList; note \"nCells:4\"; object owner; }\n// comment\n";
it("reads polyMesh label lists, patch ranges and one patch's field values",()=>{
  expect(labelList(header+"3\n(\n0\n1\n1\n)\n")).toEqual([0,1,1]);
  expect(()=>labelList(header+"3\n(\n0\n1\n)\n")).toThrow();
  expect(patchRanges("FoamFile { object boundary; }\n2\n(\ninlet\n{\ntype patch;\nnFaces 2;\nstartFace 5;\n}\nwalls\n{\ntype wall;\ninGroups 1(wall);\nnFaces 3;\nstartFace 7;\n}\n)")).toEqual({inlet:{start:5,count:2},walls:{start:7,count:3}});
  const phi="FoamFile { object phi; }\ninternalField nonuniform List<scalar> 2(1 2);\nboundaryField\n{\ninlet { type calculated; value uniform -2e-07; }\noutlet { type calculated; value nonuniform List<scalar> 2(1e-7 3e-7); }\n}";
  expect(patchValues(phi,"inlet",2)).toEqual([-2e-7,-2e-7]);
  expect(patchValues(phi,"outlet",2)).toEqual([1e-7,3e-7]);
  expect(()=>patchValues(phi,"outlet",3)).toThrow();
  expect(()=>patchValues(phi,"walls",1)).toThrow();
});

// A synthetic blockMesh-ordered grid (cell = i + j*nx) with known answers.
function grid(c:ChannelCase,u:(y:number)=>number,T:(x:number,y:number)=>number,p:(x:number)=>number){
  const dx=c.length/c.nx,dy=c.height/c.ny,depth=1e-3,centres:[number,number,number][]=[],U:number[]=[],P:number[]=[],temps:number[]=[];
  for(let j=0;j<c.ny;j++)for(let i=0;i<c.nx;i++){const x=(i+.5)*dx,y=(j+.5)*dy;centres.push([x,y,depth/2]);U.push(u(y),0,0);P.push(p(x));temps.push(T(x,y));}
  const col=(i:number)=>Array.from({length:c.ny},(_,j)=>i+j*c.nx);
  const walls=[...Array.from({length:c.nx},(_,i)=>i),...Array.from({length:c.nx},(_,i)=>i+(c.ny-1)*c.nx)];
  return channelResults(c,centres,U,P,temps,{inlet:{cells:col(0),flux:col(0).map(()=>-c.velocity*dy*depth)},outlet:{cells:col(c.nx-1),flux:col(c.nx-1).map(()=>c.velocity*dy*depth)},walls},depth);
}
it("recovers f·Re = 96 from a Poiseuille pressure gradient and closes mass for matching fluxes",()=>{
  const c:ChannelCase={...defaultChannel,thermal:false},G=12*c.nu*c.velocity/c.height**2;
  const r=grid(c,y=>1.5*c.velocity*(1-(2*y/c.height-1)**2),()=>c.inletTemperature,x=>-G*x);
  expect(r.massImbalance).toBe(0);expect(r.results.fRe).toBeCloseTo(96,6);
  expect(r.results.energyImbalance).toBeNull();expect(r.results.nusselt).toEqual([]);expect(r.results.bulkOutletTemperatureK).toBeCloseTo(c.inletTemperature,9);
});
it("uses a second-order wall gradient and the flow-weighted bulk temperature for Nu",()=>{
  // Plug flow with T = Tw - A·y(H-y): Nu on 2H is 2H²/mean(y(H-y)) = 12.
  const c:ChannelCase={...defaultChannel,ny:40,wallTemperature:330,inletTemperature:300},A=5e5;
  const r=grid(c,()=>c.velocity,(_,y)=>c.wallTemperature-A*y*(c.height-y),()=>0);
  expect(r.results.nusselt).toHaveLength(c.nx);
  for(const [,nu] of r.results.nusselt)expect(nu).toBeCloseTo(12,1);
  // Too close to the wall temperature to divide by: no local Nu.
  expect(grid(c,()=>c.velocity,()=>c.wallTemperature-1e-4,()=>0).results.nusselt).toEqual([]);
});
it("uses the imposed flux and the solver's wall face temperatures under a wall heat flux",()=>{
  // Plug flow with T = T0 + A(y - H/2)²: the wall gradient is A·H, and Nu on 2H is 12 up to the cell-centred mean.
  const A=5e5,T0=300,k=.07,c:ChannelCase={...defaultChannel,ny:40,wallHeatFlux:k*A*defaultChannel.height,conductivity:k},dy=c.height/c.ny;
  const r=grid(c,()=>c.velocity,(_,y)=>T0+A*(y-c.height/2)**2,()=>0);
  expect(r.results.nusselt).toHaveLength(c.nx);
  for(const [,nu] of r.results.nusselt)expect(nu).toBeCloseTo(12,1);
  // Face value = first cell + gradient × half a cell, as fixedGradient evaluates it.
  expect(r.results.maxWallTemperatureK).toBeCloseTo(T0+A*(dy/2-c.height/2)**2+A*c.height*dy/2,9);
});
it("assigns patch cells from the owner list",()=>{
  const boundary="3\n(\ninlet\n{\nnFaces 1;\nstartFace 2;\n}\noutlet\n{\nnFaces 1;\nstartFace 3;\n}\nwalls\n{\nnFaces 2;\nstartFace 4;\n}\n)";
  const owner=header+"6\n(\n0\n0\n0\n1\n0\n1\n)\n",phi="boundaryField\n{\ninlet { type calculated; value uniform -1; }\noutlet { type calculated; value uniform 1; }\n}";
  expect(channelPatches(boundary,owner,phi)).toEqual({inlet:{cells:[0],flux:[-1]},outlet:{cells:[1],flux:[1]},walls:[0,1]});
});
