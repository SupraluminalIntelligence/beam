import { expect, it } from "vitest";
import { ChannelCase, defaultChannel, meshKey } from "./simulation.ts";
import { channelSetupChecks, fluxWallEstimate } from "./channelChecks.ts";

// HFE-7100 near 25 °C (3M datasheet values, rounded): 1 cm gap at 1 cm/s, walls 30 K above the inlet.
const hfe:ChannelCase={...defaultChannel,velocity:.01,nu:3.8e-7,pr:9.8,density:1510,inletTemperature:293.15,wallTemperature:323.15,beta:1.8e-3,boilingPoint:334.15};
const check=(c:ChannelCase,id:string)=>channelSetupChecks(c).find(k=>k.id===id)!;

it("accepts stated fluid data without changing the mesh",()=>{
  expect(ChannelCase.parse(hfe)).toEqual(hfe);
  expect(ChannelCase.safeParse({...hfe,beta:-1}).success).toBe(false);
  expect(meshKey(hfe)).toBe(meshKey({...hfe,beta:undefined,boilingPoint:undefined}));
});
it("fails the gravity-off assumption when buoyancy dominates and passes it in a fast, narrow channel",()=>{
  const slow=check(hfe,"buoyancy");expect(slow.status).toBe("fail");expect(slow.value).toBe("Ri 106");
  expect(check({...hfe,height:.001,velocity:.2},"buoyancy").status).toBe("ok");
  expect(check({...hfe,wallTemperature:hfe.inletTemperature+.1,velocity:.02},"buoyancy").status).toBe("ok");
  expect(check({...hfe,height:.002,velocity:.1,wallTemperature:hfe.inletTemperature+20},"buoyancy").status).toBe("warn");
  expect(check({...hfe,beta:undefined},"buoyancy").status).toBe("unknown");
  expect(check({...hfe,thermal:false},"buoyancy").status).toBe("ok");
});
it("fails the single-phase assumption when a wall reaches the stated boiling point",()=>{
  expect(check(hfe,"single-phase").status).toBe("ok");
  const hot=check({...hfe,wallTemperature:353.15},"single-phase");
  expect(hot.status).toBe("fail");expect(hot.detail).toContain("80 °C");expect(hot.detail).toContain("61 °C");
  expect(check({...hfe,wallTemperature:353.15,thermal:false},"single-phase").status).toBe("ok");
  expect(check({...hfe,boilingPoint:undefined},"single-phase").status).toBe("unknown");
});
it("flags a dynamic viscosity entered as kinematic and suggests the kinematic value",()=>{
  expect(check(hfe,"viscosity").status).toBe("ok");
  expect(check(defaultChannel,"viscosity").status).toBe("ok");
  const slip=check({...hfe,nu:5.8e-4},"viscosity");
  expect(slip.status).toBe("warn");expect(slip.detail).toContain("3.8e-7 m²/s");
  expect(check({...hfe,density:1.2,pr:.71,nu:1.5e-5},"viscosity").status).toBe("info");
});
it("reports entry lengths from the parallel-plate correlations",()=>{
  expect(check(hfe,"development").value).toBe("11.6 cm / 82.5 cm");expect(check(hfe,"development").detail).toContain("still developing at the outlet");
  expect(check({...hfe,height:.001,velocity:.2},"development").value).toBe("2.32 cm / 16.5 cm");
  expect(check({...hfe,thermal:false},"development").value).toBe("11.6 cm");
  // Low Pr: heat develops within 5 cm, velocity does not.
  expect(check({...defaultChannel,length:.05,velocity:.15,nu:1e-6,pr:.1},"development").detail).toContain("Velocity is still developing at the outlet");
});
it("checks a wall heat flux against the hottest wall it predicts",()=>{
  // 0.5 W/cm² into HFE-7100 in a 1 mm gap at 10 cm/s; k = 0.069 W/m·K.
  const chip:ChannelCase={...hfe,height:.001,nx:160,velocity:.1,wallHeatFlux:5000,conductivity:.069};
  expect(ChannelCase.parse(chip)).toEqual(chip);expect(meshKey(chip)).toBe(meshKey({...chip,wallHeatFlux:undefined,conductivity:undefined}));
  expect(ChannelCase.safeParse({...chip,conductivity:undefined}).success).toBe(false);
  expect(ChannelCase.safeParse({...chip,thermal:false}).success).toBe(false);
  const est=fluxWallEstimate(chip)!;expect(est.rise).toBeCloseTo(11.24,2);expect(est.wall).toBeCloseTo(321.99,2);
  expect(check(chip,"single-phase")).toMatchObject({status:"ok",value:"12.2 K below Tsat"});
  expect(check(chip,"buoyancy").value).toBe("Ri 0.102");
  expect(check(chip,"development")).toMatchObject({value:"1.16 cm / 11.9 cm"});expect(check(chip,"development").detail).toContain("8.235");
  expect(check({...chip,conductivity:undefined},"single-phase")).toMatchObject({status:"unknown",value:"k not set"});
  const hot=check({...chip,wallHeatFlux:1e4},"single-phase");expect(hot.status).toBe("fail");expect(hot.detail).toContain("estimated outlet wall");
});
