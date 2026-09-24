import { canonicalMeshKey, signedArea, wakeGeometryAt, type PlanarCase, type WakeFields } from "@beam/contracts";
/** Compare physical integrals, never cell indices (which differ after remeshing). */
export function comparePlanarFields(a:{config:PlanarCase;fields:WakeFields;frames:Float32Array;geometry?:Float32Array|undefined},b:typeof a){
 const physics=(c:PlanarCase)=>{const {meshSize,refinements,duration,frames,...rest}=c;return canonicalMeshKey(JSON.stringify(rest));};
 if(physics(a.config)!==physics(b.config))throw new Error("Mesh comparison requires unchanged geometry, fluid properties, boundaries and initial conditions");
 const start=Math.max(a.fields.times[0]!,b.fields.times[0]!),time=Math.min(a.fields.times.at(-1)!,b.fields.times.at(-1)!);
 if(time<start)throw new Error("Runs have no overlapping physical time");
 const measure=(run:typeof a)=>{
  const {fields:f,frames}=run,n=f.centres.length,hi=f.times.findIndex(t=>t>=time),lo=Math.max(0,hi-1),blend=hi===lo?0:(time-f.times[lo]!)/(f.times[hi]!-f.times[lo]!);
  if(run.config.motion&&(!f.motion||!run.geometry))throw new Error("Moving comparison needs saved mesh coordinates");
  const polygons=f.motion&&run.geometry?wakeGeometryAt(f,run.geometry,lo,hi,blend).polygons:f.polygons;
  let area=0,speed=0,pressure=0,kineticEnergy=0,maxSpeed=0;
  for(let i=0;i<n;i++){
   const weight=Math.abs(signedArea(polygons[i]!));area+=weight;
   const at=(k:number)=>frames[(lo*n+i)*4+k]!*(1-blend)+frames[(hi*n+i)*4+k]!*blend;
   const v=Math.hypot(at(0),at(1));speed+=v*weight;pressure+=at(2)*weight;kineticEnergy+=.5*run.config.region.density*v*v*weight;maxSpeed=Math.max(maxSpeed,v);
  }
  if(!(area>0))throw new Error("Result has no fluid area");
  return{cells:n,fluidAreaM2:area,meanSpeedMS:speed/area,meanPressurePa:pressure/area,meanKineticEnergyDensityJPerM3:kineticEnergy/area,maxSpeedMS:maxSpeed};
 };
 const baseline=measure(a),candidate=measure(b);
 return{physicalTimeSeconds:time,baseline,candidate,change:{meanSpeedMS:candidate.meanSpeedMS-baseline.meanSpeedMS,meanPressurePa:candidate.meanPressurePa-baseline.meanPressurePa,meanKineticEnergyDensityJPerM3:candidate.meanKineticEnergyDensityJPerM3-baseline.meanKineticEnergyDensityJPerM3},method:"Area-weighted cell-centre fields at the latest common physical time; linear time interpolation where needed. Peak speed is a cell maximum. Fluid area can differ slightly when surface tessellation changes.",limitations:"A two-mesh comparison is not a convergence study. These are domain statistics, not drag, lift, mass balance or shedding frequency. Those diagnostics are not implemented; do not claim them."};
}
