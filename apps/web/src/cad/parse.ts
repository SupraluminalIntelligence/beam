import { Mesh, type BufferGeometry } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { checkCadFile, validateModel, type CadModel, type MeshPreview } from "./model";

export type OcctResult = { success: boolean; meshes?: { name?: string; color?: [number, number, number]; attributes: { position: { array: number[] }; normal?: { array: number[] } }; index: { array: number[] } }[] };
export interface CadImporter { ReadStepFile(bytes: Uint8Array, params: object): OcctResult; ReadIgesFile(bytes: Uint8Array, params: object): OcctResult }
export function geometryPreview(geometry: BufferGeometry, name: string): MeshPreview {
  const mesh: MeshPreview = { name, positions: new Float32Array(geometry.getAttribute("position").array) };
  const normal = geometry.getAttribute("normal");
  if (normal) mesh.normals = new Float32Array(normal.array);
  if (geometry.index) mesh.indices = new Uint32Array(geometry.index.array);
  return mesh;
}
export async function parseCad(name: string, bytes: ArrayBuffer, importer: () => Promise<CadImporter>): Promise<CadModel> {
  const format = checkCadFile(name, bytes.byteLength);
  if (format === "step" || format === "iges") {
    const occt = await importer();
    const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.35 };
    const result = format === "step" ? occt.ReadStepFile(new Uint8Array(bytes), params) : occt.ReadIgesFile(new Uint8Array(bytes), params);
    if (!result.success) throw new Error("OpenCascade could not read this model. Try exporting it again as STEP or STL.");
    return validateModel({ format: format.toUpperCase(), unit: "mm", meshes: (result.meshes ?? []).map((mesh, i) => ({
      name: mesh.name || `Part ${i + 1}`, positions: new Float32Array(mesh.attributes.position.array),
      indices: new Uint32Array(mesh.index.array), ...(mesh.attributes.normal ? { normals: new Float32Array(mesh.attributes.normal.array) } : {}),
      ...(mesh.color ? { color: mesh.color } : {}),
    })) });
  }
  if (format === "stl") {
    const geometry = new STLLoader().parse(bytes);
    try { return validateModel({ format: "STL", unit: "model units", meshes: [geometryPreview(geometry, name)] }); }
    finally { geometry.dispose(); }
  }
  // OBJ materials/textures are intentionally not fetched; this is a geometry-only preview.
  const object = new OBJLoader().parse(new TextDecoder().decode(bytes));
  const meshes: MeshPreview[] = [];
  object.traverse(child => {
    if (child instanceof Mesh) {
      if (child.geometry.getAttribute("position")?.count) meshes.push(geometryPreview(child.geometry, child.name || `Part ${meshes.length + 1}`));
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
    }
  });
  return validateModel({ format: "OBJ", unit: "model units", meshes });
}
