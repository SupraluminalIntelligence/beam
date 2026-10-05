import type { LiveView } from "@beam/contracts";

/**
 * The one history a card or a job row draws small: drag if the case reports it, else another force
 * coefficient or function object, else the first residual. Points fill a width × height box, the
 * newest at the right; a log-scale series is drawn by its logarithm.
 */
const PREFER = ["coeff-Cd", "coeff-Cl", "coeff-CmPitch"];

export function spark(view: LiveView, width = 560, height = 44): { label: string; points: string } | null {
  const order = [...PREFER.map(n => view.series.find(s => s.name === n)), ...view.series.filter(s => !PREFER.includes(s.name) && s.name !== "residuals" && s.name !== "courant"), view.series.find(s => s.name === "residuals")];
  for (const s of order) {
    const line = s?.lines.find(l => l.values.filter(v => v !== null).length > 1);
    if (!s || !line) continue;
    const pts = s.xs.map((x, i) => [x, line.values[i]] as const).filter((p): p is readonly [number, number] => typeof p[1] === "number" && Number.isFinite(p[1]) && (s.y.scale !== "log" || p[1] > 0))
      .map(([x, v]) => [x, s.y.scale === "log" ? Math.log10(v) : v] as const);
    if (pts.length < 2) continue;
    const [x0, x1] = [pts[0]![0], pts.at(-1)![0]], ys = pts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = 2, sx = (x: number) => x1 === x0 ? width : ((x - x0) / (x1 - x0)) * width, sy = (y: number) => hi === lo ? height / 2 : pad + (1 - (y - lo) / (hi - lo)) * (height - 2 * pad);
    return { label: `${s.label}, ${line.name}`, points: pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ") };
  }
  return null;
}
