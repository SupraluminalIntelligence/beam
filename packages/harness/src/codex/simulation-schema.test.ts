import { expect,it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SimulationCase,defaultPlanar,defaultDomain3d } from "@beam/contracts";
it("exposes coordinate vectors as homogeneous arrays accepted by Codex dynamic tools",()=>{
 const schema=zodToJsonSchema(z.object({config:SimulationCase}),{$refStrategy:"none"});
 const inspect=(value:unknown)=>{if(!value||typeof value!=="object")return;const row=value as Record<string,unknown>;if("items" in row)expect(Array.isArray(row.items)).toBe(false);Object.values(row).forEach(inspect);};inspect(schema);
 expect(SimulationCase.parse(defaultPlanar).geometry).toBe("planar");
 expect(SimulationCase.safeParse({...defaultPlanar,initialVelocity:[1]}).success).toBe(false);
});
it("accepts 3D studies through the same tool schema",()=>{
 expect(SimulationCase.parse(defaultDomain3d).geometry).toBe("domain3d");
 expect(SimulationCase.safeParse({...defaultDomain3d,initialVelocity:[1,0]}).success).toBe(false);
});
