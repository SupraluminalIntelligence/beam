import { seriesAxes, type ResultSeries, type SeriesData } from "@beam/contracts";
import type { PlotLine } from "./Plot";

const dimensionless = (s: ResultSeries) => s.y.unit === "" || s.y.unit === "1";
const collide = (group: ResultSeries[]) => { const names = group.flatMap(s => s.y.lines); return new Set(names).size !== names.length; };

/**
 * The plots a manifest draws, each a list of series in manifest order. A series is drawn on another's
 * plot only when it names it as its `overlay`. A manifest written before `overlay` existed (none names
 * one) had series with the same axes drawn together; that still holds for a dimensioned y whose line
 * names are all distinct, so a result shows over its reference data. Dimensionless series (Cp, y+,
 * Cl, Cd) share axes by accident, so each is drawn alone.
 */
export function plotGroups(series: ResultSeries[]): ResultSeries[][] {
  const names = new Set(series.map(s => s.name)), explicit = series.some(s => s.overlay !== undefined);
  const groups = new Map<string, ResultSeries[]>();
  for (const s of series) {
    const key = explicit ? (s.overlay !== undefined && names.has(s.overlay) ? s.overlay : s.name) : seriesAxes(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  if (explicit) return [...groups.values()];
  return [...groups.values()].flatMap(g => g.length > 1 && (dimensionless(g[0]!) || collide(g)) ? g.map(s => [s]) : [g]);
}

/** One plot's lines. A line name used by more than one series is prefixed with its series' label. */
export function plotLines(items: { s: ResultSeries; d: SeriesData }[]): PlotLine[] {
  const count = new Map<string, number>();
  for (const { d } of items) for (const l of d.lines) count.set(l.name, (count.get(l.name) ?? 0) + 1);
  return items.flatMap(({ s, d }) => d.lines.map(l => ({ name: (count.get(l.name) ?? 0) > 1 ? `${s.label}: ${l.name}` : l.name, x: d.x, y: l.values, points: d.x.length < 30 })));
}
