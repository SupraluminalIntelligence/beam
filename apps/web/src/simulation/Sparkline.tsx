import type { LiveView } from "@beam/contracts";
import { spark } from "./spark";

/** A live history drawn small, for a card or a job row. Nothing when there is not yet a history. */
export function Sparkline({ view, width = 560, height = 44 }: { view: LiveView; width?: number; height?: number }) {
  const s = spark(view, width, height);
  if (!s) return null;
  return <svg className="sim-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label={`${s.label}, as it changes`}><polyline points={s.points} fill="none" vectorEffect="non-scaling-stroke" /></svg>;
}
