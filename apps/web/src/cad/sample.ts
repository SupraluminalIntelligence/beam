import { ExtrudeGeometry, LatheGeometry, Path, Shape, Vector2 } from "three";
import { geometryPreview } from "./parse";
import type { CadModel } from "./model";
/** Beam-authored sample, in millimeters. A reducer with two drilled flanges. */
export function sampleModel(): CadModel {
  const body = new LatheGeometry([new Vector2(22, 0), new Vector2(26, 0), new Vector2(26, 12), new Vector2(40, 58), new Vector2(40, 70), new Vector2(36, 70), new Vector2(36, 58), new Vector2(22, 12), new Vector2(22, 0)], 80);
  body.rotateX(Math.PI / 2);
  const meshes = [{ ...geometryPreview(body, "Reducer body"), color: [0.62, 0.74, 0.78] as [number, number, number] }];
  body.dispose();
  for (const [name, radius, bore, z] of [["Inlet flange", 40, 22, 0], ["Outlet flange", 57, 36, 64]] as const) {
    const shape = new Shape(); shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
    const hole = new Path(); hole.absarc(0, 0, bore, 0, Math.PI * 2, true); shape.holes.push(hole);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; const bolt = new Path(); bolt.absarc(Math.cos(a) * (radius - 8), Math.sin(a) * (radius - 8), 3, 0, Math.PI * 2, true); shape.holes.push(bolt); }
    const geometry = new ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false, curveSegments: 32 }); geometry.translate(0, 0, z);
    meshes.push({ ...geometryPreview(geometry, name), color: [0.72, 0.78, 0.8] }); geometry.dispose();
  }
  return { meshes, format: "Beam sample", unit: "mm" };
}
