import { expect, it } from "vitest";
import { JobPath, ProcessJobSpec } from "./compute";

it("accepts nested case paths but rejects host paths and directory aliases",()=>{
  expect(JobPath.parse("case/system/controlDict")).toBe("case/system/controlDict");
  for(const path of ["/tmp/x","../x","a/../x","a//b","a/./b","C:/x","a\\b","a\0b"])expect(JobPath.safeParse(path).success,path).toBe(false);
});
it("requires bounded jobs and unique non-overlapping file paths",()=>{
  const spec={version:1,kind:"process",title:"Test",executable:"python3",args:["script.py"],timeoutSeconds:60,inputs:[],outputs:[]};
  expect(ProcessJobSpec.safeParse(spec).success).toBe(true);
  expect(ProcessJobSpec.safeParse({...spec,timeoutSeconds:0}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...spec,outputs:["a","a/b"]}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...spec,inputs:[{assetId:"x",path:"a"},{assetId:"y",path:"a"}]}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...spec,shell:true}).success).toBe(false);
  expect(ProcessJobSpec.safeParse({...spec,args:Array(10).fill("x".repeat(8000))}).success).toBe(false);
});
