/** Mesh previews are independent of the CAD kernel and the compute target. */
export type CadReference = { kind: "file"; id: string } | { kind: "source"; id: string } | { kind: "result"; jobId: string; assetId: string };
export type CadFormat = "step" | "iges" | "stl" | "obj";
export const CAD_ACCEPT = ".step,.stp,.iges,.igs,.stl,.obj";
export const MAX_CAD_BYTES = 20 * 1024 * 1024;
export const MAX_TRIANGLES = 2_000_000;
export type MeshPreview = { name: string; positions: Float32Array; normals?: Float32Array; indices?: Uint32Array; color?: [number, number, number] };
export type CadModel = { meshes: MeshPreview[]; unit: "mm" | "model units"; format: string };
export function cadFormat(name: string): CadFormat | null {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return ext === "step" || ext === "stp" ? "step" : ext === "iges" || ext === "igs" ? "iges" : ext === "stl" || ext === "obj" ? ext : null;
}
export function checkCadFile(name: string, size: number) {
  const format = cadFormat(name);
  if (!format) throw new Error("Open a STEP, IGES, STL, or OBJ model.");
  if (size > MAX_CAD_BYTES) throw new Error("This model is larger than the current 20 MB preview limit. Export a smaller mesh to view it here.");
  if (!size) throw new Error("This file is empty.");
  return format;
}
/** Reject invalid geometry before giving it to the GPU. Also used by future remote preview adapters. */
export function validateModel(model: CadModel): CadModel {
  if (!model.meshes.length) throw new Error("No surfaces found in this model.");
  if (model.meshes.length > 2000) throw new Error("This model has too many parts for a local preview (maximum 2,000).");
  let triangles = 0, vertices = 0;
  for (const mesh of model.meshes) {
    const count = mesh.positions.length / 3;
    if (!Number.isInteger(count) || !count || !mesh.positions.every(Number.isFinite)) throw new Error("The model contains invalid vertex coordinates.");
    const indices = mesh.indices;
    if (indices && (!indices.length || indices.length % 3 || !indices.every(i => i < count))) throw new Error("The model contains invalid triangle indices.");
    if (!indices && count % 3) throw new Error("The model contains incomplete triangles.");
    if (mesh.normals && (mesh.normals.length !== mesh.positions.length || !mesh.normals.every(Number.isFinite))) delete mesh.normals;
    triangles += (indices?.length ?? count) / 3;
    vertices += count;
    if (triangles > MAX_TRIANGLES || vertices > MAX_TRIANGLES * 3) throw new Error("This model exceeds the local preview limit of 2 million triangles. Export a coarser mesh.");
  }
  return model;
}
export function triangleCount(model: CadModel) { return model.meshes.reduce((n, m) => n + (m.indices?.length ?? m.positions.length / 3) / 3, 0); }
