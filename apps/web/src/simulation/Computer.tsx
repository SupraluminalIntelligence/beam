import { useQuery } from "convex/react";
import { formatQuantity } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import { ui } from "../lib/ui";
import { duration, openSimulation } from "./Simulations";
import { jobName } from "./phase";
import "./results.css";

type Now = NonNullable<ReturnType<typeof useThisComputer>>;
type Job = Now["jobs"][number];
const useThisComputer = () => useQuery(api.computer.thisComputer, {});
const numbers = (latest: { label: string; value: number; unit: string }[]) => latest.map(q => `${q.label} ${formatQuantity(q.value, q.unit || "1")}`).join(" · ");

/**
 * The sidebar's "This computer": what your computer is running, what is queued behind it, what waits
 * for approval, and agents working on a chat's machine, across every chat you can see. The only view
 * of compute that spans chats; each line opens its simulation.
 */
export function ThisComputer() {
  const now = useThisComputer();
  if (!now || (!now.machines.length && !now.jobs.length)) return null;
  const online = now.machines.filter(m => m.online);
  const open = (j: { workspaceId: string; chatId: string; simulation: { id: string } | null }, tab: "jobs" | "results", jobId?: string) => {
    ui.openChat(j.workspaceId, j.chatId);
    if (j.simulation) openSimulation(j.chatId, j.simulation.id, tab, jobId);
  };
  const state = (j: Job) => {
    if (j.state === "awaiting-approval") return j.needsYou ? <span className="warn">! needs you</span> : <span>waiting for {j.requestedBy}</span>;
    if (j.state === "queued") return <span>next</span>;
    const verb = j.state === "preparing" ? "starting" : j.state;
    return <span className="live">● {verb}{j.startedAt ? ` · ${duration(Date.now() - j.startedAt)}` : ""}</span>;
  };
  return <section className="sb-computer" aria-label="This computer">
    <div className="sb-sec">This computer <span className="k">{online.length ? "1 job at a time" : "offline"}</span></div>
    {now.machineWork.map(w => <button key={`m-${w.simulation.id}`} className="sb-computer-line" onClick={() => open(w, "results", "machine")} title={`${w.simulation.name} · in ${w.chatTitle}`}>
      <span className="k live">● on the machine{w.solver ? ` · ${w.solver}` : ""}</span>
      <b>{w.simulation.name}</b>
      <span className="k">{[w.simulation.draft ? "draft" : null, numbers(w.latest), w.chatTitle].filter(Boolean).join(" · ")}</span>
    </button>)}
    {now.jobs.map(j => <button key={j.id} className="sb-computer-line" onClick={() => j.simulation ? open(j, j.state === "running" || j.state === "publishing" ? "results" : "jobs", j.id) : (ui.openChat(j.workspaceId, j.chatId), ui.openSurface(j.chatId, `job:${j.id}`))} title={`${j.title} · in ${j.chatTitle}`}>
      <span className="k">{state(j)}</span>
      <b>{j.simulation?.name ?? j.title}</b>
      <span className="k">{[jobName(j), numbers(j.latest), j.cloud, j.chatTitle].filter(Boolean).join(" · ")}</span>
    </button>)}
    {!now.jobs.length && !now.machineWork.length && <div className="sb-computer-note k">{online.length ? `${online.map(m => m.name).join(", ")} · idle` : "Open Beam on your computer to run jobs on it."}</div>}
    {now.hidden > 0 && <div className="sb-computer-note k">and {now.hidden} job{now.hidden === 1 ? "" : "s"} from chats you can't see</div>}
  </section>;
}
