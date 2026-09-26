import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { gridConvergence, type ChannelMeshStudy } from "@beam/contracts";
import { MeshStudyRows, meshSensitivityValue } from "./MeshStudy";

// Values from three real OpenFOAM solves of a 1 mm HFE-7100 channel (60×8, 90×12, 135×18).
const cells: [number, number, number] = [480, 1080, 2430];
const study: ChannelMeshStudy = { cells, ratios: [1.5, 1.5], notes: [], estimates: [
  { quantity: "outlet temperature rise", unit: "K", ...gridConvergence(cells, [10.0267, 9.92322, 9.85220]) },
  { quantity: "f·Re, developed", unit: "", ...gridConvergence(cells, [93.1058, 94.6944, 95.4213]) },
  { quantity: "Nu at 198 mm", unit: "", ...gridConvergence(cells, [7.90452, 7.80625, 7.77113]) },
] };

it("reports each quantity's error band and order, and what's missing before a study exists", () => {
  const html = renderToStaticMarkup(<MeshStudyRows state={{ meshes: 3, status: "ready", study }} />);
  expect(html).toContain("outlet ΔT</span><span>2 % · p 0.9");
  expect(html).toContain("f·Re</span><span>0.8 % · p 1.9");
  expect(html).toContain("f·Re 96.03");
  expect(meshSensitivityValue({ meshes: 3, status: "ready", study })).toBe("GCI ≤ 2 %");
  expect(meshSensitivityValue({ meshes: 3, status: "ready", study: { ...study, estimates: [{ quantity: "Nu", unit: "", ...gridConvergence(cells, [7.9, 7.7, 7.8]) }] } })).toBe("1 unresolved");
  expect(meshSensitivityValue({ meshes: 2, status: "too-few" })).toBe("2 of 3 meshes");
  expect(renderToStaticMarkup(<MeshStudyRows state={{ meshes: 2, status: "too-few" }} />)).toContain("one more mesh");
  expect(meshSensitivityValue(null)).toBe("not studied");
});
