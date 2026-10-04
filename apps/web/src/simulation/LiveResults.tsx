import { useEffect, useState } from "react";
import { formatQuantity, type LiveView } from "@beam/contracts";
import { Plot } from "./Plot";

const ago = (ms: number) => (ms < 5000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const STATE: Record<string, string> = { running: "running", stopped: "stopped", done: "finished", failed: "failed" };

/** A clock that ticks while something is live, so "updated 3 s ago" moves. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  return now;
}

/**
 * The agent's work on the machine as Beam reads it from the solver's own output: the case it is
 * running, its residuals and function-object histories, checkMesh, and the latest numbers. Drawn with
 * the same pieces as published results, and labelled as what it is: unchecked, and still changing.
 */
export function LiveResults({ view, updatedAt, live }: { view: LiveView; updatedAt: number; live: boolean }) {
  const now = useNow(live);
  const c = view.case, others = view.cases.filter(x => x.path !== c.path);
  return <div className="results live-results">
    <div className="live-source">
      <span><b>{c.path}</b>{c.solver ? ` · ${c.solver}` : ""} · <span className={c.state === "running" ? "live-on" : c.state === "failed" ? "live-bad" : ""}>{STATE[c.state] ?? c.state}</span></span>
      <span className="live-ago">read {ago(Math.max(0, now - updatedAt))}</span>
      {view.command && <span className="live-command" title={view.command.text}>● {view.command.text} · {ago(Math.max(0, now - view.command.startedAt)).replace(" ago", "")}</span>}
      {others.length > 0 && <span className="live-others">also on the machine: {others.map(o => o.path).join(" · ")}</span>}
    </div>

    {view.quantities.length > 0 && <section className="results-block"><h4>Numbers <small>latest, not converged values</small></h4>
      <table className="results-table"><tbody>{view.quantities.map(q => <tr key={q.name}><th scope="row">{q.label}</th><td>{formatQuantity(q.value, q.unit || "1")}</td></tr>)}</tbody></table>
    </section>}

    {view.mesh && <section className="results-block"><h4>Mesh check <small>checkMesh</small></h4>
      <table className="results-table"><tbody>
        <tr><th scope="row">result</th><td>{view.mesh.ok === true ? "✓ Mesh OK" : view.mesh.ok === false ? "✕ failed checks" : "not reported"}</td></tr>
        {view.mesh.cells !== null && <tr><th scope="row">cells</th><td>{view.mesh.cells.toLocaleString("en-US")}</td></tr>}
        {view.mesh.maxNonOrthogonality !== null && <tr><th scope="row">max non-orthogonality</th><td>{view.mesh.maxNonOrthogonality.toFixed(1)}°</td></tr>}
        {view.mesh.maxSkewness !== null && <tr><th scope="row">max skewness</th><td>{view.mesh.maxSkewness.toPrecision(3)}</td></tr>}
        {view.mesh.maxAspectRatio !== null && <tr><th scope="row">max aspect ratio</th><td>{view.mesh.maxAspectRatio.toPrecision(3)}</td></tr>}
        {view.mesh.failed.map(f => <tr key={f} className="warn"><th scope="row">flagged</th><td>{f}</td></tr>)}
      </tbody></table>
    </section>}

    {view.series.map(s => <section key={s.name} className="results-block"><h4>{s.label}</h4>
      <Plot lines={s.lines.map(l => ({ name: l.name, x: s.xs, y: l.values.map(v => v ?? Number.NaN), points: s.xs.length < 30 }))}
        xLabel={s.x.label} xUnit={s.x.unit} yUnit={s.y.unit === "1" ? "" : s.y.unit} yScale={s.y.scale} ariaLabel={`${s.label} against ${s.x.label}, read live from the machine`} />
    </section>)}

    {!view.series.length && !view.quantities.length && !view.mesh && <p className="results-empty">The case has a mesh but nothing to plot yet.</p>}
  </div>;
}
