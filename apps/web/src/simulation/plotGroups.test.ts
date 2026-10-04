import { describe, expect, it } from "vitest";
import { ResultSeries } from "@beam/contracts";
import { plotGroups, plotLines } from "./plotGroups";

const series = (name: string, x: string, unit: string, lines: string[], overlay?: string) =>
  ResultSeries.parse({ name, label: name.replace("_", " "), data: `series/${name}.json`, points: 3, x: { label: x }, y: { unit, lines }, overlay });
const names = (groups: ResultSeries[][]) => groups.map(g => g.map(s => s.name));

// The NACA 0012 job that drew Cp, Cf and y+ on one axis, and Cl and Cd on another.
const airfoil = [
  series("pressure_coefficient", "x / c", "", ["upper", "lower"]),
  series("skin_friction", "x / c", "", ["upper", "lower"]),
  series("yplus", "x / c", "", ["upper", "lower"]),
  series("lift_history", "iteration", "", ["Cl"]),
  series("drag_history", "iteration", "1", ["Cd"]),
  series("cl_history_dimensionless", "iteration", "1", ["Cl smoothed"]),
];

describe("plotGroups", () => {
  it("draws dimensionless series apart when nothing names an overlay", () => {
    expect(names(plotGroups(airfoil))).toEqual(airfoil.map(s => [s.name]));
  });
  it("draws a series over the one it names, and nothing else together", () => {
    const withReference = [...airfoil, series("cp_experiment", "x / c", "", ["Gregory & O'Reilly"], "pressure_coefficient")];
    expect(names(plotGroups(withReference))).toEqual([
      ["pressure_coefficient", "cp_experiment"], ["skin_friction"], ["yplus"], ["lift_history"], ["drag_history"], ["cl_history_dimensionless"],
    ]);
  });
  it("keeps drawing an older manifest's dimensioned series with the same axes together", () => {
    const cavity = [series("centreline_u", "height y", "m/s", ["OpenFOAM 129x129"]), series("ghia_1982", "height y", "m/s", ["Ghia, Ghia & Shin 1982"])];
    expect(names(plotGroups(cavity))).toEqual([["centreline_u", "ghia_1982"]]);
  });
  it("draws an older manifest's series apart when their line names collide", () => {
    const walls = [series("wall_pressure", "x", "Pa", ["upper", "lower"]), series("wall_pressure_coarse", "x", "Pa", ["upper", "lower"])];
    expect(names(plotGroups(walls))).toEqual([["wall_pressure"], ["wall_pressure_coarse"]]);
  });
});

describe("plotLines", () => {
  const d = (...lines: string[]) => ({ x: [0, 1], lines: lines.map(name => ({ name, values: [0, 1] })) });
  it("prefixes only the line names two series share", () => {
    const a = series("fine", "x", "Pa", ["upper", "lower"]), b = series("coarse", "x", "Pa", ["upper", "mean"], "fine");
    expect(plotLines([{ s: a, d: d("upper", "lower") }, { s: b, d: d("upper", "mean") }]).map(l => l.name))
      .toEqual(["fine: upper", "lower", "coarse: upper", "mean"]);
  });
});
