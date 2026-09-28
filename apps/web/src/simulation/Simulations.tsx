import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { compareQuantities, formatQuantity, type FilesSetup, type Parameter, type ResultsManifest } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui } from "../lib/ui";
import { toast } from "../components/Toast";
import { Checks, Numbers, quantityText, ResultsView } from "./Results";
import { Plot } from "./Plot";
import "./results.css";
import "./study.css";

type SimId = Id<"simulationCases">;
type Sim = NonNullable<ReturnType<typeof useSimulation>>;
type Job = Sim["jobs"][number];
const useSimulation = (id: SimId) => useQuery(api.simulations.get, { id });
const state = (s: string) => s.replaceAll("-", " ");
const value = (p: Pick<Parameter, "value" | "unit">) => typeof p.value === "number" ? formatQuantity(p.value, p.unit || "1") : String(p.value);
/** A number as an engineer reads it (210 GPa), beside the raw SI value being edited, when they differ. */
const readable = (p: Parameter, raw: string | undefined) => {
  const n = Number(raw ?? p.value);
  if (typeof p.value !== "number" || !Number.isFinite(n) || !p.unit || p.unit === "1") return "";
  const shown = formatQuantity(n, p.unit);
  return shown === `${n} ${p.unit}` || shown === `${n.toLocaleString("en-US")} ${p.unit}` ? "" : ` · ${shown}`;
};
export const openSimulation = (chatId: string, id: string, tab?: Tab, jobId?: string) => {
  ui.panel(chatId, { simulationView: { id, tab: tab ?? "setup", ...(jobId ? { jobId } : {}), key: Date.now() } });
  ui.openSurface(chatId, `sim:${id}`);
};

/** The simulation's card in its chat: the latest job's state, headline numbers and checks. */
export function SimulationCard({ id, chatId }: { id: SimId; chatId: Id<"chats"> }) {
  const sim = useSimulation(id);
  if (sim === undefined) return <div className="study-card">Loading simulation…</div>;
  if (!sim) return <div className="study-card">Simulation unavailable</div>;
  const latest = sim.jobs[0], done = sim.jobs.find(j => j.state === "succeeded" && j.results);
  const status = latest && !["succeeded", "failed", "cancelled"].includes(latest.state) ? `v${latest.version} · ${state(latest.state)}` : done ? `v${done.version} · results` : latest ? `v${latest.version} · ${state(latest.state)}` : `v${sim.version} saved · not run yet`;
  return <section className="study-card sim-card" aria-label={`Simulation: ${sim.name}`}>
    <div className="study-card-heading"><span className={`job-dot ${latest?.state ?? "queued"}`} /><b>{sim.name}</b><small>Simulation · v{sim.version}</small></div>
    <div className="study-card-state" role="status">{status}</div>
    {done?.results && <div className="sim-card-results">
      {done.results.headline.map(q => <div key={q.name} className="sim-card-q"><span>{q.label}</span><b>{quantityText(q)}</b></div>)}
      <div className="sim-card-checks">✓ {done.results.checks.pass} pass{done.results.checks.review ? ` · ${done.results.checks.review} to review` : ""}{done.results.checks.fail ? ` · ${done.results.checks.fail} failed` : ""}</div>
      {done.results.flagged.map(c => <div key={c.id} className={`study-card-check ${c.status === "fail" ? "fail" : "review"}`}>{c.status === "fail" ? "✕" : "!"} {c.label}{c.value ? ` · ${c.value}` : ""}</div>)}
    </div>}
    <div className="study-card-actions">
      <button onClick={() => openSimulation(chatId, id)}>Open simulation ↗</button>
      {done && <button onClick={() => openSimulation(chatId, id, "results", done._id)}>Results ↗</button>}
      {sim.jobs.filter(j => j.results).length > 1 && <button onClick={() => openSimulation(chatId, id, "compare")}>Compare</button>}
      {latest && <button onClick={() => ui.openSurface(chatId, `job:${latest._id}`)}>{latest.state === "awaiting-approval" ? "Review job" : "Job details"}</button>}
    </div>
  </section>;
}

type Tab = "setup" | "jobs" | "results" | "compare";
/** The simulation page: its versions, jobs, results and comparisons. */
export function SimulationView({ id, chatId, login }: { id: SimId; chatId: Id<"chats">; login: string }) {
  const sim = useSimulation(id);
  const selection = ui.get().panels[chatId]?.simulationView;
  const [tab, setTab] = useState<Tab>((selection?.id === id ? selection.tab : null) ?? "setup");
  const [jobId, setJobId] = useState<string | null>(selection?.id === id ? selection.jobId ?? null : null);
  useEffect(() => { if (selection?.id === id) { setTab(selection.tab); if (selection.jobId) setJobId(selection.jobId); } }, [selection?.key]);
  // Remembered in the panel, so switching to another tool and back keeps the page where it was.
  const show = (t: Tab, j: string | null = jobId) => {
    setTab(t); setJobId(j);
    ui.panel(chatId, { simulationView: { id, tab: t, ...(j ? { jobId: j } : {}), key: selection?.id === id ? selection.key : 0 } });
  };
  if (sim === undefined) return <div className="workspace-scroll">Loading simulation…</div>;
  if (!sim) return <div className="workspace-scroll">Simulation unavailable.</div>;
  // A study from the retired Simulation pane keeps its jobs and results, but has no files setup to edit or run.
  const study = sim.kind === "recipe", tabs: Tab[] = study ? ["jobs", "results", "compare"] : ["setup", "jobs", "results", "compare"];
  const current = study && tab === "setup" ? "results" : tab;
  const shown = jobId ? sim.jobs.find(j => j._id === jobId) : sim.jobs.find(j => j.state === "succeeded" && j.results);
  return <div className="workspace-scroll sim-view">
    <div className="workspace-section-heading"><div><span className="workspace-eyebrow">{study ? "SIMULATION · STUDY" : "SIMULATION"}</span><h2>{sim.name}</h2>
      <p>{study
        ? `r${sim.version} · a study from the Simulation pane, which Beam no longer has; its jobs and results are kept here · ${sim.jobs.length} job${sim.jobs.length === 1 ? "" : "s"}`
        : `v${sim.version} · ${sim.versions.at(-1)?.setup?.environment.name} environment · ${sim.jobs.length} job${sim.jobs.length === 1 ? "" : "s"} · updated by ${sim.updatedBy}`}</p></div></div>
    <div className="sim-tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={current === t} onClick={() => show(t)}>{t}{t === "jobs" ? <small>{sim.jobs.length}</small> : t === "setup" ? <small>v{sim.version}</small> : null}</button>)}</div>
    {current === "setup" && <Setup sim={sim} chatId={chatId} onRun={j => show("jobs", j)} />}
    {current === "jobs" && <Jobs sim={sim} chatId={chatId} login={login} onOpen={j => show("results", j)} />}
    {current === "results" && (shown ? <><div className="sim-results-for">v{shown.version} · {shown.title} <button className="btn ghost" onClick={() => ui.openSurface(chatId, `job:${shown._id}`)}>Job details</button></div><ResultsView jobId={shown._id} /></> : <p className="results-empty">{study ? "No results: this study's runs predate standard results." : "No results yet. Run a version from Setup."}</p>)}
    {current === "compare" && <Compare sim={sim} />}
  </div>;
}

function Setup({ sim, chatId, onRun }: { sim: Sim; chatId: Id<"chats">; onRun: (jobId: string) => void }) {
  const [version, setVersion] = useState(sim.version);
  const v = sim.versions.find(x => x.version === version) ?? sim.versions.at(-1)!;
  const setup = v.setup as FilesSetup;
  const latest = v.version === sim.version;
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [version, sim.version]);
  const saveParameters = useMutation(api.simulations.saveParameters), run = useMutation(api.simulations.run);
  const targets = useQuery(api.compute.targets, { chatId });
  const [busy, setBusy] = useState(false);
  const edited = Object.keys(draft).length > 0;
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } catch (e) { toast((e as Error).message.replace(/^.*Uncaught Error: /, "")); } finally { setBusy(false); } };
  const parsed = (p: Parameter): Parameter => {
    const raw = draft[p.name]; if (raw === undefined) return p;
    return { ...p, value: typeof p.value === "number" ? Number(raw) : typeof p.value === "boolean" ? raw === "true" : raw };
  };
  return <div className="sim-setup">
    <div className="sim-versions">{[...sim.versions].reverse().map(x => <button key={x.version} aria-pressed={x.version === v.version} onClick={() => setVersion(x.version)}>
      <b>v{x.version}</b><span>{x.note ?? (x.version === 1 ? "First version" : x.changes.join(", ") || "No changes")}</span><small>{x.createdBy} · {new Date(x.createdAt).toLocaleString()}</small>
    </button>)}</div>
    <div className="sim-version-detail">
      {v.changes.length > 0 && <section className="results-block"><h4>What changed from v{v.from ?? v.version - 1}</h4><ul className="sim-changes">{v.changes.map(c => <li key={c}>{c}</li>)}</ul></section>}
      <section className="results-block"><h4>Parameters</h4>
        {setup.parameters.length ? <table className="results-table"><tbody>{setup.parameters.map(p => <tr key={p.name}><th scope="row">{p.label ?? p.name}<small> {p.name}</small></th>
          <td>{latest ? <label className="sim-param"><input aria-label={p.name} value={draft[p.name] ?? String(p.value)} onChange={e => setDraft({ ...draft, [p.name]: e.target.value })} /><span>{p.unit && p.unit !== "1" ? p.unit : ""}{readable(p, draft[p.name])}</span></label> : value(p)}</td></tr>)}</tbody></table>
          : <p className="results-empty">No declared parameters. Ask the agent to declare the inputs you want to vary.</p>}
        {latest && edited && <div className="sim-actions"><button className="btn" disabled={busy || setup.parameters.some(p => typeof p.value === "number" && !Number.isFinite(Number(draft[p.name] ?? p.value)))}
          onClick={() => void act(() => saveParameters({ id: sim.id as SimId, version: v.version, parameters: setup.parameters.map(parsed), note: "Parameters edited in the app" }).then(() => setDraft({})))}>Save as v{sim.version + 1}</button><button className="btn ghost" onClick={() => setDraft({})}>Discard</button></div>}
      </section>
      <section className="results-block"><h4>Run</h4>
        <pre className="compute-command">{setup.command}</pre>
        <p className="sim-meta">{setup.environment.name} · <code>{setup.environment.image.split("@sha256:")[1]?.slice(0, 12)}</code> · up to {formatQuantity(setup.timeoutSeconds, "s")}</p>
        <div className="sim-actions">{targets?.length
          ? <button className="btn" disabled={busy || edited} title={edited ? "Save or discard the parameter changes first" : undefined} onClick={() => void act(async () => onRun(await run({ id: sim.id as SimId, version: v.version, runnerId: targets[0]!.id, machine: "local", requestKey: `app-${sim.id}-v${v.version}-${Date.now()}` })))}>Run v{v.version} on {targets[0]!.name}</button>
          : <span className="results-empty">No machine is online. Open Beam on your computer to run it.</span>}</div>
      </section>
      <section className="results-block"><h4>Files</h4><ul className="results-files">{setup.files.map(f => <li key={f.path}><code>{f.path}</code></li>)}</ul></section>
    </div>
  </div>;
}

function Jobs({ sim, chatId, login, onOpen }: { sim: Sim; chatId: Id<"chats">; login: string; onOpen: (jobId: string) => void }) {
  const approve = useMutation(api.compute.approve);
  const [busy, setBusy] = useState(false);
  if (!sim.jobs.length) return <p className="results-empty">No jobs yet. Run a version from Setup.</p>;
  const mine = sim.jobs.filter(j => j.state === "awaiting-approval" && j.requestedBy === login);
  const go = async (jobs: Job[]) => { setBusy(true); try { await Promise.all(jobs.map(j => approve({ id: j._id }))); } catch (e) { toast((e as Error).message.replace(/^.*Uncaught Error: /, "")); } finally { setBusy(false); } };
  const what = (j: Job) => { const v = sim.versions.find(x => x.version === j.version); return v?.changes.length ? v.changes.join(", ") : v?.note ?? null; };
  return <div className="sim-jobs">
    {mine.length > 1 && <div className="sim-approve-all"><span>{mine.length} jobs are waiting for you to approve them.</span><button className="btn" disabled={busy} onClick={() => void go(mine)}>Approve all {mine.length}</button></div>}
    {sim.jobs.map(j => <div key={j._id} className="compute-card sim-job">
    <span className={`job-dot ${j.state}`} />
    <span><b>v{j.version} · {state(j.state)}</b>
      {what(j) && <small className="sim-job-what" title={what(j) ?? undefined}>{what(j)}</small>}
      {j.results ? <small>{j.results.headline.map(q => `${q.label} ${quantityText(q)}`).join(" · ")}{" · "}✓ {j.results.checks.pass}{j.results.checks.review ? ` · ! ${j.results.checks.review}` : ""}{j.results.checks.fail ? ` · ✕ ${j.results.checks.fail}` : ""}</small> : <small>{j.error ?? new Date(j.createdAt).toLocaleString()}</small>}</span>
    {j.results && <button className="btn ghost" onClick={() => onOpen(j._id)}>Results</button>}
    {mine.includes(j) && <button className="btn" disabled={busy} onClick={() => void go([j])}>Approve</button>}
    <button className="btn ghost" onClick={() => ui.openSurface(chatId, `job:${j._id}`)}>Details</button>
  </div>)}</div>;
}

/** A simulation tab's label: its name, so it is not confused with the Simulation tool. */
export function SimulationTabLabel({ id }: { id: SimId }) {
  const sim = useSimulation(id);
  return <>{sim?.name ?? "Simulation"}</>;
}

/** Numbers side by side, matched by name and unit; checks per job; and, for a sweep, each number against the swept parameter. */
function Compare({ sim }: { sim: Sim }) {
  const done = sim.jobs.filter(j => j.state === "succeeded" && j.results);
  const [picked, setPicked] = useState<string[]>(() => done.slice(0, 8).map(j => j._id).reverse());
  const rows = useQuery(api.simulations.results, picked.length >= 2 ? { id: sim.id as SimId, jobIds: picked as Id<"computeJobs">[] } : "skip");
  if (done.length < 2) return <p className="results-empty">Compare needs two jobs with results. Run another version, or ask the agent for a sweep.</p>;
  const loaded = (rows ?? []).filter((r): r is typeof r & { manifest: ResultsManifest } => !!r.manifest);
  return <div className="sim-compare">
    <div className="sim-compare-pick">{done.map(j => <label key={j._id}><input type="checkbox" checked={picked.includes(j._id)} onChange={e => setPicked(e.target.checked ? [...picked, j._id].slice(-8) : picked.filter(x => x !== j._id))} /> v{j.version} <small>{j.title}</small></label>)}</div>
    {picked.length < 2 ? <p className="results-empty">Pick two to eight jobs.</p> : rows === undefined ? <p className="results-empty">Loading…</p> : <>
      <CompareNumbers rows={loaded} />
      <Sweep rows={loaded} />
      <section className="results-block"><h4>Checks</h4><div className="sim-compare-checks">{loaded.map(r => <div key={r.jobId}><b>v{r.version}</b><Checks checks={r.manifest.checks} /></div>)}</div></section>
    </>}
  </div>;
}
type Row = { jobId: string; version: number | null; manifest: ResultsManifest; setup: FilesSetup | null };
function CompareNumbers({ rows }: { rows: Row[] }) {
  const base = rows[0];
  if (!base) return null;
  const names = [...new Map(rows.flatMap(r => r.manifest.quantities.map(q => [`${q.name} ${q.unit}`, q] as const))).values()];
  return <section className="results-block"><h4>Numbers</h4><div className="results-scroll"><table className="results-table">
    <thead><tr><th />{rows.map(r => <th key={r.jobId}>v{r.version}</th>)}</tr></thead>
    <tbody>{names.map(q => <tr key={`${q.name} ${q.unit}`}><th scope="row">{q.label}</th>{rows.map((r, i) => {
      const c = compareQuantities(base.manifest, r.manifest).matched.find(m => m.name === q.name && m.unit === q.unit), own = r.manifest.quantities.find(x => x.name === q.name && x.unit === q.unit);
      return <td key={r.jobId}>{own ? quantityText(own) : "—"}{i > 0 && c && c.relative !== null ? <small className={c.relative > 0 ? "up" : c.relative < 0 ? "down" : ""}> {c.relative >= 0 ? "+" : ""}{(c.relative * 100).toFixed(1)}%</small> : null}</td>;
    })}</tr>)}</tbody></table></div><p className="sim-meta">Matched by name and unit against v{base.version}. A number whose unit changed is not compared.</p></section>;
}
/** When the compared versions differ in exactly one numeric parameter, plot each headline number against it. */
function Sweep({ rows }: { rows: Row[] }) {
  const swept = useMemo(() => {
    const setups = rows.map(r => r.setup).filter((s): s is FilesSetup => !!s);
    if (setups.length !== rows.length || rows.length < 2) return null;
    const names = setups[0]!.parameters.map(p => p.name).filter(n => setups.some(s => s.parameters.find(p => p.name === n)?.value !== setups[0]!.parameters.find(p => p.name === n)?.value));
    if (names.length !== 1) return null;
    const p = setups[0]!.parameters.find(x => x.name === names[0])!;
    if (typeof p.value !== "number") return null;
    return { name: p.label ?? p.name, unit: p.unit, x: setups.map(s => Number(s.parameters.find(q => q.name === p.name)!.value)) };
  }, [rows]);
  if (!swept) return null;
  const headline = rows[0]!.manifest.quantities.filter(q => q.headline).slice(0, 3);
  return <section className="results-block"><h4>Sweep of {swept.name}</h4>{headline.map(q => {
    const pts = rows.map((r, i) => ({ x: swept.x[i]!, y: r.manifest.quantities.find(x => x.name === q.name && x.unit === q.unit)?.value ?? Number.NaN })).sort((a, b) => a.x - b.x);
    return <Plot key={q.name} lines={[{ name: q.label, x: pts.map(p => p.x), y: pts.map(p => p.y), points: true }]} xLabel={swept.name} xUnit={swept.unit === "1" ? "" : swept.unit} yUnit={q.unit === "1" ? "" : q.unit} height={200} ariaLabel={`${q.label} against ${swept.name}`} />;
  })}</section>;
}

/** The sidebar's simulations for the open workspace: both kinds, newest first. */
export function SimulationList({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const sims = useQuery(api.simulations.list, { workspaceId });
  if (!sims?.length) return null;
  return <section className="sb-sims" aria-label="Simulations">
    <div className="sb-sec">Simulations</div>
    {sims.slice(0, 12).map(s => <button key={s.id} className="th-item" title={`${s.name} · in ${s.chatTitle}`} onClick={() => {
      ui.openChat(workspaceId, s.chatId);
      openSimulation(s.chatId, s.id);
    }}><span className="sq idle" /><span className="nm">{s.name}</span><span className="sim-sb-v">{s.kind === "recipe" ? "r" : "v"}{s.version}</span></button>)}
  </section>;
}
