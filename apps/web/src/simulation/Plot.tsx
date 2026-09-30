import { useMemo, useState } from "react";
import { siScale } from "@beam/contracts";

/** points: mark each value too, for data with few points. */
export type PlotLine = { name: string; x: number[]; y: number[]; points?: boolean };
type Props = { lines: PlotLine[]; xLabel: string; xUnit?: string; yUnit?: string; yScale?: "linear" | "log"; height?: number; ariaLabel: string };

/** Round tick positions covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}
const label = (v: number) => Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1).replace("e+", "e") : String(Number(v.toPrecision(4)));
const DASH = ["", "6 4", "2 3", "10 3 2 3"];

/**
 * A results plot: x against one or more lines, drawn in ink so color stays free for fields.
 * Each axis reads in one SI-prefixed unit (µm, MPa); hovering reads the nearest point's value.
 */
export function Plot({ lines: raw, xLabel, xUnit: xBase = "", yUnit: yBase = "", yScale = "linear", height = 240, ariaLabel }: Props) {
  const { lines, xUnit, yUnit } = useMemo(() => {
    const xs = siScale(raw.flatMap(l => l.x), xBase), ys = siScale(yScale === "linear" ? raw.flatMap(l => l.y) : [], yBase);
    return { lines: raw.map(l => ({ ...l, x: l.x.map(v => v * xs.factor), y: l.y.map(v => v * ys.factor) })), xUnit: xs.unit, yUnit: ys.unit };
  }, [raw, xBase, yBase, yScale]);
  const [hover, setHover] = useState<{ line: string; x: number; y: number } | null>(null);
  const W = 640, H = height, L = 56, R = 12, T = 12, B = 34;
  const view = useMemo(() => {
    const ys = lines.flatMap(l => l.y).filter(v => Number.isFinite(v) && (yScale === "linear" || v > 0)), xs = lines.flatMap(l => l.x).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    const tr = (v: number) => (yScale === "log" ? Math.log10(v) : v);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys.map(tr)), Math.max(...ys.map(tr))];
    const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.1 || 1;
    const yTicks = yScale === "log" ? Array.from({ length: Math.floor(y1) - Math.ceil(y0 - pad) + 1 }, (_, i) => Math.ceil(y0 - pad) + i) : niceTicks(y0 - pad, y1 + pad);
    const ylo = Math.min(y0 - pad, ...yTicks), yhi = Math.max(y1 + pad, ...yTicks), xTicks = niceTicks(x0, x1);
    // Inset from the axes, so a mark at either end of the range is drawn whole.
    const px = (v: number) => L + 8 + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (W - L - R - 16);
    const py = (v: number) => T + (1 - (tr(v) - ylo) / (yhi - ylo)) * (H - T - B);
    return { px, py, xTicks: xTicks.filter(t => t >= x0 && t <= x1), yTicks, tr, ylo, yhi };
  }, [lines, yScale, H]);
  if (!view) return <p className="results-empty">No finite values to plot.</p>;
  const tickLabel = (t: number) => yScale === "log" ? `1e${t}` : label(t);
  const yPos = (t: number) => T + (1 - (t - view.ylo) / (view.yhi - view.ylo)) * (H - T - B);
  return <figure className="results-plot">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}
      onMouseMove={e => {
        const box = e.currentTarget.getBoundingClientRect(), mx = (e.clientX - box.left) / box.width * W, my = (e.clientY - box.top) / box.height * H;
        let best: typeof hover = null, dist = Infinity;
        for (const l of lines) l.x.forEach((x, i) => { const y = l.y[i]!; if (!Number.isFinite(y) || (yScale === "log" && y <= 0)) return; const d = Math.hypot(view.px(x) - mx, view.py(y) - my); if (d < dist) { dist = d; best = { line: l.name, x, y }; } });
        setHover(dist < 24 ? best : null);
      }}>
      {view.yTicks.map(t => <g key={`y${t}`}><line x1={L} x2={W - R} y1={yPos(t)} y2={yPos(t)} className="grid" /><text x={L - 6} y={yPos(t) + 3} textAnchor="end">{tickLabel(t)}</text></g>)}
      {view.xTicks.map(t => <g key={`x${t}`}><line x1={view.px(t)} x2={view.px(t)} y1={T} y2={H - B} className="grid" /><text x={view.px(t)} y={H - B + 14} textAnchor="middle">{label(t)}</text></g>)}
      <line x1={L} x2={L} y1={T} y2={H - B} className="axis" /><line x1={L} x2={W - R} y1={H - B} y2={H - B} className="axis" />
      {lines.map((l, i) => {
        const pts = l.x.map((x, j) => [x, l.y[j]!] as const).filter(([, y]) => Number.isFinite(y) && (yScale === "linear" || y > 0));
        return <g key={`${i}:${l.name}`}>
          <polyline className={`series line m${i % 4}`} strokeDasharray={DASH[i % DASH.length]} points={pts.map(([x, y]) => `${view.px(x).toFixed(1)},${view.py(y).toFixed(1)}`).join(" ")} />
          {l.points && <g className="series">{pts.map(([x, y], j) => <circle key={j} cx={view.px(x)} cy={view.py(y)} r={3} className={`mark m${i % 4}`} />)}</g>}
        </g>;
      })}
      {hover && <circle cx={view.px(hover.x)} cy={view.py(hover.y)} r={4.5} className="hover" />}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" className="axis-label">{xLabel}{xUnit ? ` (${xUnit})` : ""}</text>
    </svg>
    <figcaption>
      {lines.map((l, i) => <span key={`${i}:${l.name}`} className="legend"><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" className={`series line m${i % 4}`} strokeDasharray={DASH[i % DASH.length]} />{l.points && <circle cx="11" cy="4" r="3" className={`mark m${i % 4}`} />}</svg>{l.name}</span>)}
      <span className="readout">{hover ? `${hover.line} · ${label(hover.x)}${xUnit ? ` ${xUnit}` : ""} → ${label(hover.y)}${yUnit ? ` ${yUnit}` : ""}` : yUnit ? `y in ${yUnit}${yScale === "log" ? " · log scale" : ""}` : ""}</span>
    </figcaption>
  </figure>;
}
