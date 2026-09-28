import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { formatQuantity, ResultsManifest, SeriesData, TableData, type ResultCheck, type ResultQuantity, type ResultSeries } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Plot, type PlotLine } from "./Plot";
import "./results.css";

type Output = { path: string; size: number; url: string | null };
const MAX_JSON = 2 * 1024 * 1024;
const MARK: Record<ResultCheck["status"], string> = { pass: "✓", review: "!", fail: "✕", "not-evaluated": "–" };

/** A published JSON file, validated. */
function useJson<T>(url: string | null | undefined, size: number, parse: (v: unknown) => T) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    if (!url) { setState({ data: null, error: "Not published" }); return; }
    if (size > MAX_JSON) { setState({ data: null, error: "Too large to show here; download it" }); return; }
    const abort = new AbortController();
    fetch(url, { signal: abort.signal }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(v => setState({ data: parse(v), error: null }), e => { if (!abort.signal.aborted) setState({ data: null, error: (e as Error).message }); });
    return () => abort.abort();
  }, [url, size]);
  return state;
}

export function quantityText(q: Pick<ResultQuantity, "value" | "unit" | "uncertainty">) {
  const u = q.uncertainty, band = u?.relative !== undefined ? ` ±${Number((u.relative * 100).toPrecision(2))}%` : u?.absolute !== undefined ? ` ±${formatQuantity(u.absolute, q.unit)}` : "";
  return `${formatQuantity(q.value, q.unit)}${band}`;
}
export function Numbers({ quantities }: { quantities: ResultQuantity[] }) {
  if (!quantities.length) return null;
  return <table className="results-table numbers"><tbody>{quantities.map(q => {
    const ref = q.reference, delta = ref && ref.value !== 0 ? (q.value - ref.value) / Math.abs(ref.value) : null;
    return <tr key={q.name}><th scope="row">{q.label}</th><td>{quantityText(q)}{q.uncertainty ? <small> {q.uncertainty.kind.toUpperCase()}</small> : null}</td>
      <td className="ref">{ref ? <>{formatQuantity(ref.value, q.unit)} <small>{ref.source}{delta !== null ? ` · ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%` : ""}</small></> : null}</td></tr>;
  })}</tbody></table>;
}
export function Checks({ checks }: { checks: ResultCheck[] }) {
  if (!checks.length) return <p className="results-empty warn">This job recorded no checks, so nothing says how far to trust it.</p>;
  return <ul className="results-checks">{checks.map(c => <li key={c.id} className={c.status}>
    <span className="mark" aria-label={c.status}>{MARK[c.status]}</span>
    <span><b>{c.label}</b>{c.value ? <> · {c.value}</> : null}{c.criterion ? <small> ({c.criterion})</small> : null}{c.detail ? <em>{c.detail}</em> : null}</span>
    <small className="stage">{c.stage}</small>
  </li>)}</ul>;
}

/** Plots with the same axes are drawn together, so a result shows over its reference data. */
function plotGroups(series: ResultSeries[]) {
  const groups = new Map<string, ResultSeries[]>();
  for (const s of series) { const key = `${s.x.label}|${s.x.unit}|${s.y.unit}|${s.y.scale}|${s.kind}`; groups.set(key, [...(groups.get(key) ?? []), s]); }
  return [...groups.values()];
}
function PlotGroup({ series, outputs }: { series: ResultSeries[]; outputs: Output[] }) {
  const data = series.map(s => { const o = outputs.find(x => x.path === `beam/out/${s.data}`); return { s, o }; });
  return <section className="results-block"><h4>{series.map(s => s.label).join(" · ")}</h4>
    <PlotData items={data} />
  </section>;
}
/** Every series of one plot, fetched together. */
function useSeries(items: { s: ResultSeries; o: Output | undefined }[]) {
  const key = items.map(i => i.o?.url ?? "").join("|");
  const [state, setState] = useState<{ data: SeriesData[] | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    const missing = items.find(i => !i.o?.url || i.o.size > MAX_JSON);
    if (missing) { setState({ data: null, error: missing.o ? "Too large to show here; download it" : `${missing.s.label} was not published` }); return; }
    const abort = new AbortController();
    Promise.all(items.map(i => fetch(i.o!.url!, { signal: abort.signal }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(v => SeriesData.parse(v))))
      .then(data => setState({ data, error: null }), e => { if (!abort.signal.aborted) setState({ data: null, error: (e as Error).message }); });
    return () => abort.abort();
  }, [key]);
  return state;
}
function PlotData({ items }: { items: { s: ResultSeries; o: Output | undefined }[] }) {
  const { data, error } = useSeries(items);
  if (error) return <p className="results-empty">{error}</p>;
  if (!data) return <p className="results-empty">Loading…</p>;
  const first = items[0]!.s;
  const lines: PlotLine[] = data.flatMap(d => d.lines.map(line => ({ name: line.name, x: d.x, y: line.values, points: d.x.length < 30 })));
  return <Plot lines={lines} xLabel={first.x.label} xUnit={first.x.unit} yUnit={first.y.unit} yScale={first.y.scale} ariaLabel={`${items.map(i => i.s.label).join(", ")} against ${first.x.label}`} />;
}
function Table({ label, output }: { label: string; output: Output | undefined }) {
  const { data, error } = useJson(output?.url, output?.size ?? 0, v => TableData.parse(v));
  return <section className="results-block"><h4>{label}</h4>{error ? <p className="results-empty">{error}</p> : !data ? <p className="results-empty">Loading…</p> :
    <div className="results-scroll"><table className="results-table"><thead><tr>{data.columns.map(c => <th key={c.name}>{c.name}{c.unit ? <small> {c.unit}</small> : null}</th>)}</tr></thead>
      <tbody>{data.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{typeof cell === "number" ? formatQuantity(cell, data.columns[j]?.unit ?? "") : cell ?? "—"}</td>)}</tr>)}</tbody></table></div>}
  </section>;
}

/** Everything a job's manifest describes, with its evidence first. */
export function ResultsView({ jobId }: { jobId: Id<"computeJobs"> }) {
  const job = useQuery(api.compute.get, { id: jobId });
  if (job === undefined) return <p className="results-empty">Loading results…</p>;
  if (!job) return <p className="results-empty">Job unavailable.</p>;
  if (job.state !== "succeeded") return <p className="results-empty">{job.state === "failed" ? `The job failed: ${job.error ?? "see its log"}` : `Results appear when the job succeeds (now ${job.state.replaceAll("-", " ")}).`}</p>;
  const parsed = job.results?.manifest ? ResultsManifest.safeParse(job.results.manifest) : null;
  if (!parsed?.success) return <p className="results-empty">This job wrote no results manifest. Its files are under Job details.</p>;
  const m = parsed.data, outputs = job.outputs as Output[], p = m.provenance;
  const files = outputs.filter(o => !/^beam\/out\/(manifest\.json|series\/|tables\/|preview\/)/.test(o.path));
  return <div className="results">
    <p className="results-provenance">{[p.environment, p.image ? `${p.image.split("@")[0]!.split("/").at(-1)}@${p.image.split("sha256:")[1]?.slice(0, 7) ?? ""}` : null, p.arch, p.wallSeconds !== undefined ? `${formatQuantity(p.wallSeconds, "s")} wall` : null].filter(Boolean).join(" · ")}</p>
    <section className="results-block"><h4>Checks</h4><Checks checks={m.checks} /></section>
    {m.quantities.length > 0 && <section className="results-block"><h4>Numbers</h4><Numbers quantities={m.quantities} /></section>}
    {plotGroups(m.series).map(g => <PlotGroup key={g.map(s => s.name).join()} series={g} outputs={outputs} />)}
    {m.tables.map(t => <Table key={t.name} label={t.label} output={outputs.find(o => o.path === `beam/out/${t.data}`)} />)}
    {m.fields.length > 0 && <section className="results-block"><h4>3D</h4><p className="results-empty">{m.fields.map(f => `${f.label} (${f.arrays.map(a => a.name).join(", ")})`).join(" · ")}. The 3D view is next; download the full data to open it in ParaView.</p></section>}
    {(files.length > 0 || (job.results?.unpublished.length ?? 0) > 0) && <section className="results-block"><h4>Files</h4><ul className="results-files">
      {files.map(o => <li key={o.path}><a href={o.url ?? undefined} target="_blank" rel="noreferrer" download={o.path.split("/").at(-1)}>{o.path.replace(/^beam\/out\//, "")}</a> <small>{formatQuantity(o.size, "1")} bytes</small></li>)}
      {job.results?.unpublished.map(u => <li key={u.path} className="kept">{u.path.replace(/^beam\/out\//, "")} <small>{u.reason}</small></li>)}
    </ul></section>}
  </div>;
}
