import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { compareQuantities, formatQuantity, MACHINES, type FilesSetup, type LiveView, type MachineId, type Parameter, type ResultsManifest } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui } from "../lib/ui";
import { toast } from "../components/Toast";
import { Checks, Numbers, quantityText, ResultsView } from "./Results";
import { Plot } from "./Plot";
import { LiveResults } from "./LiveResults";
import { isLive, jobName, phase } from "./phase";
import { Sparkline } from "./Sparkline";
import "./results.css";
import "./study.css";

type SimId = Id<"simulationCases">;
type Sim = NonNullable<ReturnType<typeof useSimulation>>;
type Job = Sim["jobs"][number];
const useSimulation = (id: SimId) => useQuery(api.simulations.get, { id });
const useLive = (id: SimId) => useQuery(api.live.forSimulation, { id });
const useJobLives = (id: SimId) => useQuery(api.live.jobsForSimulation, { id });
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
  ui.panel(chatId, { simulationView: { id, tab: tab ?? "results", ...(jobId ? { jobId } : {}), key: Date.now() } });
  ui.openSurface(chatId, `sim:${id}`);
};

/** A duration as people say it: 45 s, 9 min, 1 h 20 min. */
export const duration = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)} min` : ""}`; };
const machineName = (id: string) => id === "local" ? "this computer" : MACHINES[id as MachineId]?.label ?? id;
/** The latest numbers of a live view, in one line. */
const latest = (view: LiveView, n = 4) => [...view.quantities.slice(0, n).map(q => `${q.label} ${formatQuantity(q.value, q.unit || "1")}`), ...(view.mesh?.ok === true ? ["checkMesh OK"] : view.mesh?.ok === false ? ["checkMesh failed"] : [])].join(" · ");
const errorText = (e: unknown) => (e as Error).message.replace(/^.*Uncaught Error: /, "");

/**
 * The simulation's card in its chat, updated in place through its life: the agent's work on the
 * machine, a running job, then checked results. Each live phase draws its history small with the
 * latest numbers. A job waiting for approval is approved here or on the Jobs tab.
 */
export function SimulationCard({ id, chatId, login }: { id: SimId; chatId: Id<"chats">; login?: string }) {
  const sim = useSimulation(id), live = useLive(id), jobLives = useJobLives(id);
  const approve = useMutation(api.compute.approve), cancel = useMutation(api.compute.cancel);
  const [busy, setBusy] = useState(false);
  if (sim === undefined) return <div className="study-card">Loading simulation…</div>;
  if (!sim) return <div className="study-card">Simulation unavailable</div>;
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } catch (e) { toast(errorText(e)); } finally { setBusy(false); } };
  const done = sim.jobs.find(j => j.state === "succeeded" && j.results), now = phase(sim, live ?? null, Date.now(), jobLives ?? []);
  const running = now.kind === "job" ? sim.jobs.find(j => j._id === now.jobId) : undefined;
  const shown = now.kind === "machine" ? live : running ? jobLives?.find(l => l.jobId === running._id) : undefined;
  const mine = sim.jobs.filter(j => j.state === "awaiting-approval" && j.requestedBy === login);
  return <section className="study-card sim-card" aria-label={`Simulation: ${sim.name}`}>
    <div className="study-card-heading"><span className={`job-dot ${now.live ? "running" : sim.jobs[0]?.state ?? "queued"}`} /><b>{sim.name}</b><small>{sim.draft ? "Draft simulation" : `Simulation · v${sim.version}`}</small></div>
    <div className={`study-card-state${now.live ? " live" : ""}`} role="status">{now.text}</div>
    {shown && <><Sparkline view={shown.view} />{latest(shown.view) && <div className="sim-card-line">{latest(shown.view)}</div>}</>}
    {now.kind === "results" && done?.results && <div className="sim-card-results">
      {done.results.headline.map(q => <div key={q.name} className="sim-card-q"><span>{q.label}</span><b>{quantityText(q)}</b></div>)}
      <div className="sim-card-checks">✓ {done.results.checks.pass} pass{done.results.checks.review ? ` · ${done.results.checks.review} to review` : ""}{done.results.checks.fail ? ` · ${done.results.checks.fail} failed` : ""}</div>
      {done.results.flagged.map(c => <div key={c.id} className={`study-card-check ${c.status === "fail" ? "fail" : "review"}`}>{c.status === "fail" ? "✕" : "!"} {c.label}{c.value ? ` · ${c.value}` : ""}</div>)}
    </div>}
    {now.waiting && <div className="sim-card-waiting"><span>! {now.waiting}</span>{mine.length > 0 && <button className="btn" disabled={busy} onClick={() => void act(() => Promise.all(mine.map(j => approve({ id: j._id }))))}>{mine.length > 1 ? `Approve all ${mine.length}` : "Approve"}</button>}</div>}
    <div className="study-card-actions">
      <button onClick={() => openSimulation(chatId, id)}>Open ↗</button>
      {now.waiting && <button onClick={() => openSimulation(chatId, id, "jobs")}>Jobs</button>}
      {running && <button onClick={() => ui.openSurface(chatId, `job:${running._id}`)}>Job log</button>}
      {running && !running.cancelRequestedAt && <button disabled={busy} onClick={() => void act(() => cancel({ id: running._id }))}>Cancel job</button>}
      {now.kind === "results" && sim.jobs.filter(j => j.results).length > 1 && <button onClick={() => openSimulation(chatId, id, "compare")}>Compare</button>}
      {sim.draft && now.kind === "machine" && <small>Not saved yet. Nothing here is checked.</small>}
    </div>
  </section>;
}

type Tab = "setup" | "jobs" | "results" | "compare";
/** The simulation page: its versions, jobs, results and comparisons. */
export function SimulationView({ id, chatId, login }: { id: SimId; chatId: Id<"chats">; login: string }) {
  const sim = useSimulation(id), live = useLive(id), jobLives = useJobLives(id) ?? [];
  const selection = ui.get().panels[chatId]?.simulationView;
  const [tab, setTab] = useState<Tab>((selection?.id === id ? selection.tab : null) ?? "results");
  const [jobId, setJobId] = useState<string | null>(selection?.id === id ? selection.jobId ?? null : null);
  useEffect(() => { if (selection?.id === id) { setTab(selection.tab); setJobId(selection.jobId ?? null); } }, [selection?.key]);
  // Remembered in the panel, so switching to another tool and back keeps the page where it was.
  const show = (t: Tab, j: string | null = jobId) => {
    setTab(t); setJobId(j);
    ui.panel(chatId, { simulationView: { id, tab: t, ...(j ? { jobId: j } : {}), key: selection?.id === id ? selection.key : 0 } });
  };
  if (sim === undefined) return <div className="workspace-scroll">Loading simulation…</div>;
  if (!sim) return <div className="workspace-scroll">Simulation unavailable.</div>;
  // A study from the retired Simulation pane keeps its jobs and results, but has no files setup to edit or run.
  const study = sim.kind === "recipe", tabs: Tab[] = study ? ["results", "jobs", "compare"] : ["results", "setup", "jobs", "compare"];
  const current = study && tab === "setup" ? "results" : tab;
  // Results follows the latest: the machine's work, a running job, then a job's results.
  const at = Date.now(), now = phase(sim, live ?? null, at, jobLives);
  // Jobs Showing can offer: each with results, and each read live that has none (running, or ended without results).
  const offered = sim.jobs.filter(j => j.results || jobLives.some(l => l.jobId === j._id));
  const pick = jobId === "machine" && live ? "machine" : jobId && sim.jobs.some(j => j._id === jobId) ? jobId
    : now.kind === "machine" ? "machine" : now.kind === "job" || now.kind === "results" ? now.jobId : offered[0]?._id ?? null;
  const shown = pick && pick !== "machine" ? sim.jobs.find(j => j._id === pick) : undefined;
  const shownLive = shown && !shown.results ? jobLives.find(l => l.jobId === shown._id) : undefined;
  const waiting = sim.jobs.filter(j => j.state === "awaiting-approval");
  return <div className="workspace-scroll sim-view">
    <div className="workspace-section-heading"><div><span className="workspace-eyebrow">{study ? "SIMULATION · STUDY" : sim.draft ? "SIMULATION · DRAFT" : "SIMULATION"}</span><h2>{sim.name}</h2>
      {!study && <p className={`sim-phase${now.live ? " live" : ""}`} role="status">{now.live ? "● " : ""}{now.text}{now.waiting && <button className="sim-phase-waiting" onClick={() => show("jobs")}> · {now.waiting}</button>}</p>}
      <p>{study
        ? `r${sim.version} · a study from the Simulation pane, which Beam no longer has; its jobs and results are kept here · ${sim.jobs.length} job${sim.jobs.length === 1 ? "" : "s"}`
        : sim.draft ? `Not saved yet · named after its folder until the agent saves v1 · ${sim.jobs.length} job${sim.jobs.length === 1 ? "" : "s"}`
        : `v${sim.version} · ${sim.versions.at(-1)?.setup?.environment.name} environment · ${sim.jobs.length} job${sim.jobs.length === 1 ? "" : "s"} · updated by ${sim.updatedBy}`}</p></div></div>
    <div className="sim-tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={current === t} onClick={() => show(t)}>{t}{t === "jobs" ? <small className={waiting.length ? "warn" : ""}>{waiting.length ? `${waiting.length} waiting` : sim.jobs.length}</small> : t === "setup" ? <small>{sim.draft ? "unsaved" : `v${sim.version}`}</small> : t === "results" && now.live ? <small className="live">live</small> : null}</button>)}</div>
    {current === "setup" && (sim.draft || !sim.versions.length ? <p className="results-empty">Not saved yet. The agent saves the setup as v1 when it works; until then, Results shows its work on the machine.</p> : <Setup sim={sim} chatId={chatId} onRun={j => show("jobs", j)} />)}
    {current === "jobs" && <Jobs sim={sim} chatId={chatId} login={login} jobLives={jobLives} onOpen={j => show("results", j)} />}
    {current === "results" && <>
      {(live || offered.length > 1 || (offered.length === 1 && pick !== offered[0]!._id)) && <div className="sim-showing" role="group" aria-label="Showing">
        <span>Showing</span>
        {live && <button aria-pressed={pick === "machine"} onClick={() => show("results", "machine")}>{now.kind === "machine" && now.live ? "● " : ""}machine work</button>}
        {offered.map(j => { const l = jobLives.find(x => x.jobId === j._id), on = !j.results && isLive(l, at);
          return <button key={j._id} aria-pressed={pick === j._id} onClick={() => show("results", j._id)}>{on ? "● " : ""}{jobName(j)} {j.results ? "results" : on ? "live" : state(j.state)}{j.results && j.endedAt ? ` · ${new Date(j.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</button>; })}
      </div>}
      {pick === "machine" && live ? <LiveResults view={live.view} updatedAt={live.updatedAt} live={now.kind === "machine" && now.live} />
        : shown?.results ? <><div className="sim-results-for">{jobName(shown)} · {shown.title} <button className="btn ghost" onClick={() => ui.openSurface(chatId, `job:${shown._id}`)}>Job details</button></div><ResultsView jobId={shown._id} /></>
        : shown && shownLive ? <><div className="sim-results-for">{jobName(shown)} · {state(shown.state)} · read from its solver as it runs; its checked results replace this when it finishes <button className="btn ghost" onClick={() => ui.openSurface(chatId, `job:${shown._id}`)}>Job log</button></div><LiveResults view={shownLive.view} updatedAt={shownLive.updatedAt} live={isLive(shownLive, at)} /></>
        : shown ? <p className="results-empty">{jobName(shown)} is {state(shown.state)}. {["queued", "awaiting-approval"].includes(shown.state) ? "Its results appear here once it runs." : shown.state === "failed" || shown.state === "cancelled" ? "It published no results." : "Nothing to read from its solver yet; its log is in Job log."} <button className="btn ghost" onClick={() => ui.openSurface(chatId, `job:${shown._id}`)}>Job log</button></p>
        : <p className="results-empty">{study ? "No results: this study's runs predate standard results." : sim.draft ? "Nothing on the machine yet." : "No results yet. Run a version from Setup."}</p>}
    </>}
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

type JobLive = NonNullable<ReturnType<typeof useJobLives>>[number];
const ACTIVE = ["preparing", "running", "publishing"];
/**
 * The simulation's jobs, by what they need: approval, running (live), queued, and done. Only this
 * simulation's: what this computer runs across chats is in the sidebar.
 */
function Jobs({ sim, chatId, login, jobLives, onOpen }: { sim: Sim; chatId: Id<"chats">; login: string; jobLives: JobLive[]; onOpen: (jobId: string) => void }) {
  const approve = useMutation(api.compute.approve), cancel = useMutation(api.compute.cancel);
  const [busy, setBusy] = useState(false);
  if (!sim.jobs.length) return <p className="results-empty">{sim.draft ? "No jobs yet. Jobs the agent runs before saving belong here too." : "No jobs yet. Run a version from Setup."}</p>;
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } catch (e) { toast(errorText(e)); } finally { setBusy(false); } };
  const mine = sim.jobs.filter(j => j.state === "awaiting-approval" && j.requestedBy === login);
  const what = (j: Job) => { const v = sim.versions.find(x => x.version === j.version); return v?.changes.length ? v.changes.join(", ") : v?.note ?? j.title; };
  const at = Date.now();
  const row = (j: Job) => {
    const l = jobLives.find(x => x.jobId === j._id), active = ACTIVE.includes(j.state);
    const when = j.state === "awaiting-approval" || j.state === "queued" ? `up to ${duration(j.timeoutSeconds * 1000)}` : j.startedAt ? duration((j.endedAt ?? at) - j.startedAt) : "";
    return <div key={j._id} className="sim-job-row">
      <span className={`job-dot ${j.state}`} />
      <b>{jobName(j)}</b>
      <span className="sim-job-what">
        {j.state === "awaiting-approval" ? <>{what(j)} · requested by {j.requestedBy} {new Date(j.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{j.resume && <> · then @{j.resume.handle} continues: {j.resume.note}</>}</>
          : active && l ? <>{latest(l.view, 3) || what(j)}<Sparkline view={l.view} width={220} height={18} /></>
          : j.results ? <>{j.results.headline.map(q => `${q.label} ${quantityText(q)}`).join(" · ")}{" · "}✓ {j.results.checks.pass}{j.results.checks.review ? ` · ! ${j.results.checks.review}` : ""}{j.results.checks.fail ? ` · ✕ ${j.results.checks.fail}` : ""}</>
          : j.error ? <span className="bad">{j.error}</span> : <>{what(j)}{j.state === "cancelled" ? " · cancelled · no results" : j.state === "succeeded" ? " · no results written" : ""}</>}
      </span>
      <span className="sim-job-where">{machineName(j.machine)}{when ? ` · ${when}` : ""}</span>
      <span className="sim-job-actions">
        {mine.includes(j) && <><button className="btn" disabled={busy} onClick={() => void act(() => approve({ id: j._id }))}>Approve</button><button className="btn ghost" disabled={busy} onClick={() => void act(() => cancel({ id: j._id }))}>Deny</button></>}
        {j.state === "awaiting-approval" && !mine.includes(j) && <small>waiting for {j.requestedBy}</small>}
        {(j.results || (l && j.state !== "awaiting-approval")) && <button className="link" onClick={() => onOpen(j._id)}>Results ↗</button>}
        {j.state !== "awaiting-approval" && <button className="link" onClick={() => ui.openSurface(chatId, `job:${j._id}`)}>Log</button>}
        {(active || j.state === "queued") && !j.cancelRequestedAt && <button className="link" disabled={busy} onClick={() => void act(() => cancel({ id: j._id }))}>Cancel</button>}
        {j.cancelRequestedAt && !["succeeded", "failed", "cancelled"].includes(j.state) && <small>cancelling…</small>}
        {j.resume?.error && <small className="warn" title={j.resume.note}>{j.resume.error}</small>}
      </span>
    </div>;
  };
  const groups: [string, string, Job[]][] = [
    [mine.length ? "Needs you" : "Waiting for approval", "approve before it runs", sim.jobs.filter(j => j.state === "awaiting-approval")],
    ["Running", "live", sim.jobs.filter(j => ACTIVE.includes(j.state))],
    ["Queued", "this computer runs one job at a time", sim.jobs.filter(j => j.state === "queued")],
    ["Done", "", sim.jobs.filter(j => ["succeeded", "failed", "cancelled"].includes(j.state))],
  ];
  return <div className="sim-jobs">
    {mine.length > 1 && <div className="sim-approve-all"><span>{mine.length} jobs are waiting for you to approve them.</span><button className="btn" disabled={busy} onClick={() => void act(() => Promise.all(mine.map(j => approve({ id: j._id }))))}>Approve all {mine.length}</button></div>}
    {groups.filter(([, , jobs]) => jobs.length).map(([title, hint, jobs]) => <section key={title} className="sim-job-group">
      <h4>{title}{hint && <small className={title === "Running" ? "live" : ""}>{hint}</small>}</h4>
      {jobs.map(row)}
    </section>)}
  </div>;
}

/** A simulation tab's label: its name, so it is not confused with the Simulation tool. */
export function SimulationTabLabel({ id }: { id: SimId }) {
  const sim = useSimulation(id);
  return <>{sim?.name ?? "Simulation"}{sim?.draft ? " · draft" : ""}</>;
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
