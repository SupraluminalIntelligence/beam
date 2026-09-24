import type { WakeFields } from "@beam/contracts";
/** Shared nodal reconstruction for the convex cells exported by our mesh generators.
 * Never pin a separate centre sample: mixing that with averaged corners creates
 * a false tent-shaped extremum inside each cell. Probes still read raw cell data.
 */
export function wakeDisplayMesh(fields:WakeFields,diameter:number){
 const vertices:number[]=[],indices:number[]=[],samples:{cell:number;weight:number}[][]=[],corners=new Map<string,number>(),sourceVertices:number[]=[];
 fields.polygons.forEach((polygon,cell)=>{
  const centre=fields.centres[cell]!;
  const ring=polygon.map((p,j)=>{const source=fields.motion?.cellVertices[cell]?.[j];const key=source===undefined?p.map(v=>v.toPrecision(9)).join(","):String(source);let id=corners.get(key);if(id===undefined){id=samples.length;corners.set(key,id);vertices.push(p[0]/diameter,p[1]/diameter);samples.push([]);sourceVertices.push(source??-1);}samples[id]!.push({cell,weight:1/Math.max(1e-12,Math.hypot(p[0]-centre[0],p[1]-centre[1]))});return id;});
  for(let i=1;i<ring.length-1;i++)indices.push(ring[0]!,ring[i]!,ring[i+1]!);
 });
 for(const row of samples){const sum=row.reduce((s,p)=>s+p.weight,0);for(const p of row)p.weight/=sum;}
 if(samples.length>65535)throw new Error("Display mesh exceeds index limit");
 return{vertices:new Float32Array(vertices),indices:new Uint16Array(indices),samples,sourceVertices};
}
/** Reuse topology while moving positions and nodal weights with the solver mesh. */
export function moveWakeDisplayMesh(mesh:ReturnType<typeof wakeDisplayMesh>,positions:Float32Array,centres:number[][],diameter:number){
 mesh.sourceVertices.forEach((source,i)=>{if(source<0)throw new Error("Missing moving vertex address");const x=positions[source*2]!,y=positions[source*2+1]!;mesh.vertices[i*2]=x/diameter;mesh.vertices[i*2+1]=y/diameter;const row=mesh.samples[i]!;let sum=0;for(const p of row){const c=centres[p.cell]!;p.weight=1/Math.max(1e-12,Math.hypot(x-c[0]!,y-c[1]!));sum+=p.weight;}for(const p of row)p.weight/=sum;});
}
export function createWakeRenderer(canvas:HTMLCanvasElement,fields:WakeFields,diameter:number){
 const gl=canvas.getContext("webgl",{alpha:false,antialias:true});if(!gl)return null;
 const mesh=wakeDisplayMesh(fields,diameter),values=new Float32Array(mesh.samples.length);
 const compile=(kind:number,source:string)=>{const shader=gl.createShader(kind)!;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)??"Shader failed");return shader;};
 const vertex=compile(gl.VERTEX_SHADER,`attribute vec2 position; attribute float value; uniform vec2 scale; uniform vec2 offset; varying float v; void main(){v=value;gl_Position=vec4(position*scale+offset,0.,1.);}`);
 const fragment=compile(gl.FRAGMENT_SHADER,`precision highp float; varying float v; uniform vec2 range; uniform float diverging; void main(){float t=clamp((v-range.x)/max(0.000001,range.y-range.x),0.,1.);vec3 c;if(diverging>0.5){c=t<0.5?mix(vec3(73.,164.,209.),vec3(16.,24.,31.),t*2.):mix(vec3(16.,24.,31.),vec3(245.,173.,86.),(t-.5)*2.);}else{c=t<.5?mix(vec3(15.,24.,34.),vec3(44.,115.,146.),t*2.):mix(vec3(44.,115.,146.),vec3(215.,237.,222.),(t-.5)*2.);}gl_FragColor=vec4(c/255.,1.);}`);
 const program=gl.createProgram()!;gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error("Display program failed");gl.useProgram(program);
 const position=gl.createBuffer()!,value=gl.createBuffer()!,index=gl.createBuffer()!;
 gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferData(gl.ARRAY_BUFFER,mesh.vertices,gl.STATIC_DRAW);const pos=gl.getAttribLocation(program,"position");gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
 gl.bindBuffer(gl.ARRAY_BUFFER,value);gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);const val=gl.getAttribLocation(program,"value");gl.enableVertexAttribArray(val);gl.vertexAttribPointer(val,1,gl.FLOAT,false,0,0);
 gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,mesh.indices,gl.STATIC_DRAW);
 const scaleUniform=gl.getUniformLocation(program,"scale"),offsetUniform=gl.getUniformLocation(program,"offset"),rangeUniform=gl.getUniformLocation(program,"range"),diverging=gl.getUniformLocation(program,"diverging");
 return{
  draw(width:number,height:number,scale:number,origin:number,cellValues:Float32Array,range:number[],diverge:boolean,originY=height/2,moving?:{positions:Float32Array;centres:number[][]}){
   if(moving){moveWakeDisplayMesh(mesh,moving.positions,moving.centres,diameter);gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferSubData(gl.ARRAY_BUFFER,0,mesh.vertices);}
   mesh.samples.forEach((row,i)=>{values[i]=row.reduce((s,p)=>s+cellValues[p.cell]!*p.weight,0);});
   const ratio=Math.min(devicePixelRatio,2),w=Math.round(width*ratio),h=Math.round(height*ratio);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
   gl.viewport(0,0,w,h);gl.clearColor(9/255,13/255,16/255,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.uniform2f(scaleUniform,2*scale/width,2*scale/height);gl.uniform2f(offsetUniform,2*origin/width-1,1-2*originY/height);gl.uniform2f(rangeUniform,range[0]!,range[1]!);gl.uniform1f(diverging,diverge?1:0);
   gl.bindBuffer(gl.ARRAY_BUFFER,value);gl.bufferSubData(gl.ARRAY_BUFFER,0,values);gl.drawElements(gl.TRIANGLES,mesh.indices.length,gl.UNSIGNED_SHORT,0);
  },
  dispose(){gl.deleteBuffer(position);gl.deleteBuffer(value);gl.deleteBuffer(index);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);}
 };
}
