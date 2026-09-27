import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { SimulationReport, channelMeshStudy, channelPhysicsKey, type ChannelMeshStudy, type GridEstimate, type SimulationCase } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

type JobRow = { _id: Id<"computeJobs">; state: string; simulation: { stage: "mesh" | "solve"; config: SimulationCase } | null };
export type MeshStudyState = { meshes: number } & ({ status: "too-few" } | { status: "loading" } | { status: "problem"; problem: string } | { status: "ready"; study: ChannelMeshStudy });

const meshOf = (c: SimulationCase) => c.geometry === "channel" ? `${c.nx}x${c.ny}` : "";

/** The selected channel solve plus the latest solves of the same setup on two other meshes, and their grid convergence study. */
export function useMeshStudy(jobs: JobRow[], jobId: Id<"computeJobs"> | undefined, report: SimulationReport | null): MeshStudyState | null {
  const config = report?.config.geometry === "channel" ? report.config : null, key = config && channelPhysicsKey(config);
  const others: JobRow[] = [];
  if (config) for (const j of jobs) {
    const c = j.simulation?.config;
    if (others.length < 2 && j._id !== jobId && j.state === "succeeded" && j.simulation?.stage === "solve" && c?.geometry === "channel" && channelPhysicsKey(c) === key && meshOf(c) !== meshOf(config) && !others.some(o => meshOf(o.simulation!.config) === meshOf(c))) others.push(j);
  }
  const a = useQuery(api.compute.get, others[0] ? { id: others[0]._id } : "skip"), b = useQuery(api.compute.get, others[1] ? { id: others[1]._id } : "skip");
  const urls = [a, b].map(d => d?.outputs.find(o => o.path === "report.json" && o.size <= 8e6)?.url ?? null), ready = others.length === 2 && urls.every(Boolean);
  const [result, setResult] = useState<{ key: string; state: MeshStudyState } | null>(null), requestKey = `${jobId}:${urls.join(",")}`;
  useEffect(() => {
    if (!ready || !report) return;
    const controller = new AbortController();
    void Promise.all(urls.map(async url => { const r = await fetch(url!, { signal: controller.signal }); if (!r.ok) throw new Error("Result download failed"); return SimulationReport.parse(await r.json()); }))
      .then(reports => { const study = channelMeshStudy([report, ...reports]); setResult({ key: requestKey, state: "problem" in study ? { meshes: 3, status: "problem", problem: study.problem } : { meshes: 3, status: "ready", study } }); })
      .catch(e => { if (!controller.signal.aborted) setResult({ key: requestKey, state: { meshes: 3, status: "problem", problem: e instanceof Error ? e.message : String(e) } }); });
    return () => controller.abort();
  }, [requestKey, ready, report]);
  if (!config) return null;
  if (others.length < 2) return { meshes: 1 + others.length, status: "too-few" };
  return result?.key === requestKey ? result.state : { meshes: 3, status: "loading" };
}

const label = (e: GridEstimate) => e.quantity.replace("outlet temperature rise", "outlet ΔT").replace(", developed", "");
const percent = (n: number) => `${Number((n * 100).toPrecision(2))} %`;
const estimateValue = (e: GridEstimate) => e.convergence === "monotonic" ? `${percent(e.gci!)} · p ${e.order!.toFixed(1)}` : e.convergence === "unchanged" ? "unchanged" : e.convergence === "plateau" ? "plateau" : e.convergence === "oscillatory" ? "oscillates" : "diverges";

/** Short verdict for the checks list. */
export function meshSensitivityValue(state: MeshStudyState | null) {
  if (!state || state.status === "too-few") return state ? `${state.meshes} of 3 meshes` : "not studied";
  if (state.status === "loading") return "loading";
  if (state.status === "problem" || !state.study.estimates.length) return "not estimated";
  const unresolved = state.study.estimates.filter(e => e.convergence !== "monotonic" && e.convergence !== "unchanged").length;
  const worst = Math.max(0, ...state.study.estimates.map(e => e.gci ?? 0));
  return unresolved ? `${unresolved} unresolved` : `GCI ≤ ${percent(worst)}`;
}

/** Per-quantity grid convergence on the three meshes, or what is missing to estimate it. */
export function MeshStudyRows({ state }: { state: MeshStudyState }) {
  if (state.status === "too-few") return <p>Solve this setup on {3 - state.meshes === 1 ? "one more mesh, about 1.5× finer than the others" : "two more meshes, each about 1.5× finer than the last"} in both directions with the same cell shape, to estimate discretization error.</p>;
  if (state.status === "loading") return <p>Reading the other two solves…</p>;
  if (state.status === "problem") return <p className="sim-warning">{state.problem}</p>;
  const { study } = state, extrapolated = study.estimates.filter(e => e.extrapolated != null && e.convergence === "monotonic").map(e => `${label(e)} ${Number(e.extrapolated!.toPrecision(4))}${e.unit ? ` ${e.unit}` : ""}`);
  return <>
    <div className="sim-value"><span>cells</span><span>{study.cells.map(n => n.toLocaleString()).join(" · ")}</span></div>
    {study.estimates.map(e => <div className={`sim-value sim-check ${e.convergence === "monotonic" || e.convergence === "unchanged" ? "info" : "warn"}`} key={e.quantity} title={`${e.values.map(v => Number(v.toPrecision(5))).join(" → ")}${e.extrapolated != null ? `; extrapolated ${Number(e.extrapolated.toPrecision(5))}` : ""}${e.unit ? ` ${e.unit}` : ""}`}><span>{label(e)}</span><span>{estimateValue(e)}</span></div>)}
    {extrapolated.length > 0 && <p>Extrapolated to zero cell size: {extrapolated.join(", ")}.</p>}
    {study.notes.map(n => <p key={n}>{n}</p>)}
    <p>GCI is the fine-mesh error band with a 1.25 safety factor, and p the observed order (Celik et al. 2008). Temperature is advected with first-order upwind, so expect p near 1 for the outlet temperature rise.</p>
  </>;
}
