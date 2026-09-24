import { useEffect, useState } from "react";
import { jobFinished } from "@beam/contracts";

export type ProgressJob = {
  state: string;
  createdAt: number;
  startedAt?: number | undefined;
  cancelRequestedAt?: number | undefined;
  runnerOnline?: boolean | undefined;
  simulation: { stage: "mesh" | "solve"; revision: number } | null;
};

export function simulationPhase(job: ProgressJob): string {
  const mesh = job.simulation?.stage === "mesh";
  if (job.cancelRequestedAt && !jobFinished(job.state)) return mesh ? "Stopping mesh job" : "Stopping solver";
  switch (job.state) {
    case "awaiting-approval": return mesh ? "Mesh awaiting approval" : "Solve awaiting approval";
    case "queued": return mesh ? "Mesh queued" : "Solve queued";
    case "preparing": return mesh ? "Preparing mesh" : "Preparing solver";
    case "running": return mesh ? "Generating and checking mesh" : "Simulation running";
    case "publishing": return mesh ? "Publishing mesh" : "Publishing simulation results";
    case "succeeded": return mesh ? "Mesh checked" : "Simulation complete";
    case "failed": return mesh ? "Mesh failed" : "Simulation failed";
    case "cancelled": return mesh ? "Mesh cancelled" : "Simulation cancelled";
    default: return "Waiting for job status";
  }
}

export function SimulationProgress({ job, onOpen }: { job: ProgressJob; onOpen: () => void }) {
  const [now, setNow] = useState(Date.now());
  const active = !jobFinished(job.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const offline = job.runnerOnline === false;
  const approval = job.state === "awaiting-approval";
  const cancelling = !!job.cancelRequestedAt;
  const working = !offline && !approval && !cancelling && ["preparing", "running", "publishing"].includes(job.state);
  const tone = offline || approval ? "attention" : working ? "live" : "waiting";
  const seconds = Math.max(0, Math.floor((now - (job.startedAt ?? job.createdAt)) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hint = offline ? "Runner disconnected · showing its last reported state."
    : approval ? "Approve this job to continue."
    : cancelling ? "Waiting for the runner to confirm cancellation."
    : job.state === "queued" ? "Waiting for the runner to start."
    : job.state === "preparing" ? "Preparing the case and starting OpenFOAM."
    : job.state === "publishing" ? "Computation finished · saving output files."
    : job.simulation?.stage === "mesh" ? "Building cells and running mesh quality checks."
    : "OpenFOAM is solving · results appear after the job finishes.";
  return <section className={`sim-progress ${tone}`} aria-label="Simulation job progress">
    <span className="sim-progress-marker" aria-hidden="true" />
    <div className="sim-progress-copy" role="status" aria-live="polite">
      <div className="sim-progress-title">{offline ? "Runner disconnected" : simulationPhase(job)}<span>r{job.simulation?.revision}</span></div>
      <p>{hint}</p>
    </div>
    <span className="sim-progress-elapsed" title={job.startedAt ? "Elapsed since the job started" : "Elapsed since the job was submitted"}>{elapsed} elapsed</span>
    <button onClick={onOpen}>{approval ? "Review job" : "View job log"} ↗</button>
  </section>;
}
