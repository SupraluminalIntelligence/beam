import { cadFormat } from "../cad/model";
import { useMutation, useQuery } from "convex/react";
import { useRef, useState } from "react";
import { ProcessJobSpec, jobFinished } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui } from "../lib/ui";
import { rememberBrowserUrl } from "../browser/BrowserStart";
import { extractTerminalLinks } from "../vendor/t3code/terminalLinks";
import { normalizePreviewUrl } from "../vendor/t3code/previewUrl";
import { toast } from "./Toast";

export function JobCard({ id, chatId }: { id: Id<"computeJobs">; chatId: Id<"chats"> }) {
  const job = useQuery(api.compute.get, { id });
  return <button className="compute-card" onClick={() => ui.openSurface(chatId, `job:${id}`)}><span className={`job-dot ${job?.state ?? "queued"}`} /><span><b>{job?.spec.title ?? "Compute job"}</b><small>{job?.state.replaceAll("-", " ") ?? "Loading…"}{job?.cancelRequestedAt && !jobFinished(job.state) ? " · cancellation requested" : ""}</small></span><span className="compute-open">Open ↗</span></button>;
}

export function ComputeJobs({ chatId }: { chatId: Id<"chats"> }) {
  const jobs = useQuery(api.compute.list, { chatId });
  const [creating, setCreating] = useState(false);
  return <div className="workspace-scroll"><div className="workspace-section-heading"><div><h2>Compute jobs</h2><p>Run work independently of the conversation.</p></div><button className="btn" onClick={() => setCreating(!creating)}>{creating ? "Close form" : "+ New job"}</button></div>
    {creating && <NewJob chatId={chatId} />}
    {jobs === undefined ? <p>Loading jobs…</p> : jobs.length ? <div className="compute-list">{jobs.map(j => <button key={j._id} className="compute-card" onClick={() => ui.openSurface(chatId, `job:${j._id}`)}><span className={`job-dot ${j.state}`} /><span><b>{j.title}</b><small>{j.state.replaceAll("-", " ")} · {new Date(j.createdAt).toLocaleString()}</small></span><span>↗</span></button>)}</div> : <div className="workspace-empty"><b>No jobs yet</b><p>Submit a local computation here, or ask an agent to run one. Logs and results stay with this chat.</p></div>}
  </div>;
}

function NewJob({ chatId }: { chatId: Id<"chats"> }) {
  const targets = useQuery(api.compute.targets, { chatId }) ?? [];
  const files = useQuery(api.files.list, { chatId }) ?? [];
  const submit = useMutation(api.compute.submit), importFile = useMutation(api.compute.importFile);
  const [runner, setRunner] = useState("");
  const [title, setTitle] = useState("Local computation"), [executable, setExecutable] = useState("python3"), [args, setArgs] = useState('["analysis.py"]');
  const [timeout, setTimeoutValue] = useState(3600), [outputs, setOutputs] = useState(""), [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  async function run() {
    setError(""); setBusy(true);
    try {
      const runnerId = (runner || targets[0]?.id) as Id<"runners">;
      if (!runnerId) throw new Error("Start an updated Beam runner to enable local compute");
      const draft = ProcessJobSpec.parse({ version: 1, kind: "process", title, executable, args: JSON.parse(args), timeoutSeconds: timeout, inputs: Object.entries(inputs).map(([assetId,path])=>({assetId,path})), outputs: outputs.split("\n").map(p=>p.trim()).filter(Boolean) });
      const fingerprint = JSON.stringify({ runnerId, draft });
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
      const staged = [];
      for (const input of draft.inputs) staged.push({ path: input.path, assetId: await importFile({ fileId: input.assetId as Id<"files">, path: input.path }) });
      const id = await submit({ chatId, runnerId, requestKey: submission.current.key, spec: { ...draft, inputs: staged } });
      ui.openSurface(chatId, `job:${id}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="compute-form" onSubmit={e => { e.preventDefault(); void run(); }}><fieldset disabled={busy}>
    <label>Title<input required value={title} onChange={e=>setTitle(e.target.value)} /></label>
    <label>Run on<select value={runner || targets[0]?.id || ""} onChange={e=>setRunner(e.target.value)}>{!targets.length && <option value="">No compute runner connected</option>}{targets.map(t=><option key={t.id} value={t.id}>{t.name} · local</option>)}</select></label>
    <label>Executable<input required value={executable} onChange={e=>setExecutable(e.target.value)} placeholder="python3, blockMesh, …" /></label>
    <label>Arguments · JSON array<textarea rows={3} value={args} onChange={e=>setArgs(e.target.value)} spellCheck={false} /></label>
    <p className="compute-help">Runs in a separate directory containing the selected inputs. The executable must be installed on the selected machine.</p>
    <label>Maximum runtime · seconds<input type="number" min={1} max={86400} required value={timeout} onChange={e=>setTimeoutValue(Number(e.target.value))} /></label>
    <div className="compute-inputs"><b>Input files from chat</b>{files.map(f=><div key={f._id}><label><input type="checkbox" checked={inputs[f._id] !== undefined} onChange={e=>setInputs(current=>{const next={...current};if(e.target.checked)next[f._id]=f.name;else delete next[f._id];return next;})} />{f.name}</label>{inputs[f._id] !== undefined && <input aria-label={`Job path for ${f.name}`} value={inputs[f._id]} onChange={e=>setInputs({...inputs,[f._id]:e.target.value})} />}</div>)}{!files.length && <p>Attach and send files in chat to include them here.</p>}</div>
    <label>Result files · one relative path per line<textarea rows={3} value={outputs} onChange={e=>setOutputs(e.target.value)} placeholder={"results.csv\nreport.json"} /></label>
    <p className="compute-help">20 MB per file · 100 MB total input. Listed result files must exist for the job to complete.</p>
    {error && <p role="alert" className="compute-error">{error}</p>}<button className="btn" type="submit" disabled={!targets.length}>{busy ? "Submitting…" : "Run job"}</button>
  </fieldset></form>;
}

export function ComputeJob({ id, login, chatId }: { id: Id<"computeJobs">; login: string; chatId: Id<"chats"> }) {
  const job = useQuery(api.compute.get, { id });
  const cancel = useMutation(api.compute.cancel), approve = useMutation(api.compute.approve);
  const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch(e) {toast((e as Error).message);} finally {setBusy(false);} };
  if (job === undefined) return <div className="workspace-scroll">Loading job…</div>;
  if (!job || job.chatId !== chatId) return <div className="workspace-scroll">Job unavailable in this chat.</div>;
  const finished = jobFinished(job.state);
  return <div className="workspace-scroll"><div className="workspace-section-heading"><div><span className="workspace-eyebrow">COMPUTE JOB</span><h2>{job.spec.title}</h2><p><span className={`job-dot ${job.state}`} /> {job.state.replaceAll("-"," ")} · {job.runnerName}</p></div></div>
    {job.state === "awaiting-approval" && <div className="compute-notice"><b>Waiting for {job.requestedBy} to approve</b><p>Review the command and inputs before running it.</p>{login === job.requestedBy && <button className="btn" disabled={busy} onClick={()=>void action(()=>approve({id}))}>Approve and run</button>}</div>}
    {!finished && !job.runnerOnline && <p className="compute-notice">Runner disconnected. This is the last reported state; the job may still be running locally. Updates resume when the runner reconnects.</p>}
    {job.cancelRequestedAt && !finished && <p role="status">Cancellation requested · waiting for the runner.</p>}
    <div className="compute-facts"><span>Submitted by <b>{job.requestedBy}</b></span><span>Runtime limit <b>{job.spec.timeoutSeconds}s</b></span><span>Input snapshot <b>{job.spec.inputs.length} files</b></span></div>
    <pre className="compute-command">{job.spec.executable}{job.spec.args.map(a=>` ${JSON.stringify(a)}`).join("")}</pre>
    <details><summary>Input snapshot and requested results</summary><ul>{job.spec.inputs.map(i=><li key={i.path}>Input: {i.path} <small>({i.assetId})</small></li>)}{job.spec.outputs.map(p=><li key={p}>Output: {p}</li>)}</ul></details>
    <div className="workspace-section-heading"><h3>Logs</h3><small>Latest 16,000 characters</small></div><pre className="compute-log" aria-label="Job log">{job.log ? <JobLog text={job.log} chatId={chatId} /> : (finished ? "No output was written." : "Waiting for output…")}</pre>
    {job.error && <p role="alert" className="compute-error">{job.error}</p>}
    {job.outputs.length > 0 && <section><h3>Results</h3>{job.outputs.map(o=><div key={o.id}><a className="compute-result" href={o.url ?? undefined} target="_blank" rel="noreferrer" download={o.path.split("/").at(-1)}><span>{o.path}</span><small>{Math.ceil(o.size/1024)} KB · Download ↗</small></a>{cadFormat(o.path) && <button className="btn ghost" onClick={()=>ui.openCad(chatId,{kind:"result",jobId:id,assetId:o.id})}>Open in CAD Viewer ↗</button>}</div>)}</section>}
    {!finished && <button className="btn" disabled={busy || !!job.cancelRequestedAt} onClick={()=>void action(()=>cancel({id}))}>{job.cancelRequestedAt ? "Cancelling…" : "Cancel job"}</button>}
  </div>;
}

function JobLog({text,chatId}:{text:string;chatId:string}) {
  let cursor=0;const parts=[];
  for(const link of extractTerminalLinks(text)) {
    parts.push(text.slice(cursor,link.start));
    parts.push(<button className="job-log-link" key={link.start} onClick={()=>{try{rememberBrowserUrl(chatId,normalizePreviewUrl(link.text));ui.openSurface(chatId,"browser");}catch{toast("Cannot open this URL");}}}>{link.text}</button>);cursor=link.end;
  }
  parts.push(text.slice(cursor));return <>{parts}</>;
}
