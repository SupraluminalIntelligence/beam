import { cadFormat } from "../cad/model";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { jobFinished } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui } from "../lib/ui";
import { rememberBrowserUrl } from "../browser/BrowserStart";
import { extractTerminalLinks } from "../vendor/t3code/terminalLinks";
import { normalizePreviewUrl } from "../vendor/t3code/previewUrl";
import { toast } from "./Toast";
import { formatBytes, OutputLink } from "./OutputLink";
import { ResultsView } from "../simulation/Results";
import { openSimulation } from "../simulation/Simulations";

/** The simulation a job belongs to: the one it was attached to, or the version it runs. */
const simulationOf = (job: { simulationId?: string; spec: { kind: string; simulation?: unknown } }) =>
  job.simulationId ?? (job.spec.kind === "environment" ? (job.spec.simulation as { caseId: string } | undefined)?.caseId : undefined);

/** An older chat's line for a job, from before every job belonged to a simulation: opens its simulation's Jobs tab when it has one. */
export function JobCard({ id, chatId }: { id: Id<"computeJobs">; chatId: Id<"chats"> }) {
  const job = useQuery(api.compute.get, { id });
  const sim = job ? simulationOf(job) : undefined;
  return <button className="compute-card" onClick={() => sim ? openSimulation(chatId, sim, "jobs", id) : ui.openSurface(chatId, `job:${id}`)}><span className={`job-dot ${job?.state ?? "queued"}`} /><span><b>{job?.spec.title ?? "Compute job"}</b><small>{job?.state.replaceAll("-", " ") ?? "Loading…"}{job?.cancelRequestedAt && !jobFinished(job.state) ? " · cancellation requested" : ""}</small></span><span className="compute-open">Open ↗</span></button>;
}

export function ComputeJob({ id, login, chatId }: { id: Id<"computeJobs">; login: string; chatId: Id<"chats"> }) {
  const job = useQuery(api.compute.get, { id });
  const cancel = useMutation(api.compute.cancel), approve = useMutation(api.compute.approve);
  const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch(e) {toast((e as Error).message);} finally {setBusy(false);} };
  if (job === undefined) return <div className="workspace-scroll">Loading job…</div>;
  if (!job || job.chatId !== chatId) return <div className="workspace-scroll">Job unavailable in this chat.</div>;
  const finished = jobFinished(job.state);
  const sim = simulationOf(job);
  return <div className="workspace-scroll"><div className="workspace-section-heading"><div><span className="workspace-eyebrow">JOB</span><h2>{job.spec.title}</h2><p><span className={`job-dot ${job.state}`} /> {job.state.replaceAll("-"," ")} · {job.runnerName}</p></div>{sim && <button className="btn ghost" onClick={() => openSimulation(chatId, sim, "jobs", id)}>Simulation ↗</button>}</div>
    {job.state === "awaiting-approval" && <div className="compute-notice"><b>Waiting for {job.requestedBy} to approve</b><p>Review the command and inputs before running it.{job.resume ? " Approving also lets the agent continue when it ends." : ""}</p>{login === job.requestedBy && <button className="btn" disabled={busy} onClick={()=>void action(()=>approve({id}))}>Approve and run</button>}</div>}
    {job.resume && <p className="compute-notice">{job.resume.sentAt ? `@${job.resume.handle} was asked to continue: ` : `When it ends, @${job.resume.handle} continues: `}{job.resume.note}{job.resume.error ? <><br /><span className="bad">{job.resume.error}</span></> : null}</p>}
    {!finished && !job.runnerOnline && <p className="compute-notice">Runner disconnected. This is the last reported state; the job may still be running locally. Updates resume when the runner reconnects.</p>}
    {job.cancelRequestedAt && !finished && <p role="status">Cancellation requested · waiting for the runner.</p>}
    <div className="compute-facts"><span>Submitted by <b>{job.requestedBy}</b></span><span>Runtime limit <b>{job.spec.timeoutSeconds}s</b></span><span>Input snapshot <b>{job.spec.inputs.length} files</b></span></div>
    {job.spec.kind === "environment"
      ? <><div className="compute-facts"><span>Environment <b>{job.spec.environment.name}</b></span><span>Machine <b>{job.spec.machine}</b></span></div><pre className="compute-command">{job.spec.command}</pre></>
      : <pre className="compute-command">{job.spec.executable}{job.spec.args.map(a=>` ${JSON.stringify(a)}`).join("")}</pre>}
    <details><summary>Input snapshot and requested results</summary><ul>{job.spec.inputs.map(i=><li key={i.path}>Input: {i.path} <small>({i.assetId})</small></li>)}{job.spec.kind === "environment" ? <li>Results: whatever the job writes under beam/out, as its manifest describes · <small>{job.spec.environment.image}</small></li> : job.spec.outputs.map(p=><li key={p}>Output: {p}</li>)}</ul></details>
    {job.results?.unpublished.length ? <p className="compute-notice">Not published: {job.results.unpublished.map(u=>`${u.path} (${u.reason})`).join(", ")}</p> : null}
    <div className="workspace-section-heading"><h3>Logs</h3><small>Latest 16,000 characters</small></div><pre className="compute-log" aria-label="Job log">{job.log ? <JobLog text={job.log} chatId={chatId} /> : (finished ? "No output was written." : "Waiting for output…")}</pre>
    {job.error && <p role="alert" className="compute-error">{job.error}</p>}
    {job.state === "succeeded" && job.results?.manifest ? <section className="compute-results"><h3>Results</h3><ResultsView jobId={id} /></section> : null}
    {job.outputs.length > 0 && <section><h3>{job.results?.manifest ? "All files" : "Results"}</h3>{job.outputs.map(o=><div key={o.id}><OutputLink className="compute-result" jobId={id} output={o}><span>{o.path}</span><small>{formatBytes(o.size)}{o.storage === "r2" ? " · large-output storage" : ""} · Download ↗</small></OutputLink>{cadFormat(o.path) && o.storage !== "r2" && <button className="btn ghost" onClick={()=>ui.openCad(chatId,{kind:"result",jobId:id,assetId:o.id as Id<"computeAssets">})}>Open in CAD Viewer ↗</button>}</div>)}</section>}
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
