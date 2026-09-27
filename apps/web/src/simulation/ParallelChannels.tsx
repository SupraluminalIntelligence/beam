import { useState } from "react";
import { parallelLayout, type ParallelChannelsCase, type ParallelChannelsResults, type SimulationFields, type SimulationReport } from "@beam/contracts";

const number = (n: number) => Number(n.toPrecision(4)).toString();
const percent = (n: number) => `${Number((n * 100).toPrecision(3))} %`;
/** Volumetric flow per metre of depth, shown in cm²/s. */
const flow = (q: number) => `${number(q * 1e4)} cm²/s`;
const celsius = (k: number) => `${number(k - 273.15)} °C`;
const gravityLabel = { off: "off", stacked: "down · 1 lowest", upflow: "flow upward", downflow: "flow downward" } as const;
// Keeps labels readable over a coloured field.
const halo = { paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 2.5, strokeLinejoin: "round" } as const;
export const channelName = (c: ParallelChannelsCase, k: number) => `channel ${k + 1}${c.channels[k]!.heatFlux > 0 ? " · heated" : ""}`;
// Line styles tell channels apart without a second colour scale.
const dashes = ["", "6 4", "2 4", "10 3 2 3"];

function Field({ label, value, set, unit = "", scale = 1 }: { label: string; value: number; set: (n: number) => void; unit?: string; scale?: number }) {
  return <label className="sim-value"><span>{label}</span><span><input aria-label={label} type="number" step="any" value={Number((value * scale).toPrecision(10))} onChange={e => { if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) set(e.target.valueAsNumber / scale); }} /><i>{unit}</i></span></label>;
}

/** Setup for parallel channels between two manifolds: geometry, each channel's heating, inlet, fluid and gravity. */
export function ParallelRail({ config: c, change }: { config: ParallelChannelsCase; change: (c: ParallelChannelsCase) => void }) {
  const set = <K extends keyof ParallelChannelsCase>(k: K) => (v: ParallelChannelsCase[K]) => change({ ...c, [k]: v });
  const count = (n: number) => change({ ...c, channels: Array.from({ length: n }, (_, k) => c.channels[k] ?? { heatFlux: 0 }) });
  return <>
    <div className="sim-section-title">GEOMETRY <span>{c.channels.length} channels</span></div>
    <label className="sim-value"><span>channels</span><select aria-label="Number of channels" value={c.channels.length} onChange={e => count(Number(e.target.value))}>{[2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <Field label="channel length" value={c.channelLength} set={set("channelLength")} unit="mm" scale={1000} />
    <Field label="channel height" value={c.channelHeight} set={set("channelHeight")} unit="mm" scale={1000} />
    <Field label="wall between" value={c.wallThickness} set={set("wallThickness")} unit="mm" scale={1000} />
    <Field label="manifold length" value={c.manifoldLength} set={set("manifoldLength")} unit="mm" scale={1000} />
    <p>Equal channels separated by solid walls, between an inlet and an outlet manifold that each span every channel and wall. The walls are holes in the fluid: no heat conducts through them.</p>
    <div className="sim-section-title">HEATING <span>both walls of a channel</span></div>
    {c.channels.map((ch, k) => <Field key={k} label={`channel ${k + 1}`} value={ch.heatFlux} set={q => change({ ...c, channels: c.channels.map((old, j) => j === k ? { heatFlux: q } : old) })} unit="W/cm²" scale={1e-4} />)}
    <p>Each channel's flux enters the fluid through its floor and ceiling; 0 leaves them adiabatic. Channel 1 is at the bottom of the drawing.</p>
    <div className="sim-section-title">INLET</div>
    <Field label="mean velocity" value={c.velocity} set={set("velocity")} unit="m/s" />
    <label className="sim-value"><span>profile</span><select aria-label="Inlet profile" value={c.inletProfile} onChange={e => set("inletProfile")(e.target.value as ParallelChannelsCase["inletProfile"])}><option value="uniform">Uniform</option><option value="parabolic">Parabolic</option></select></label>
    <Field label="temperature" value={c.inletTemperature} set={set("inletTemperature")} unit="K" />
    <p>{c.inletProfile === "parabolic" ? `Developed laminar profile across the manifold, peaking at ${number(1.5 * c.velocity)} m/s.` : "The same velocity across the whole manifold inlet."} The outlet is at 0 Pa gauge.</p>
    <div className="sim-section-title">FLUID · CONSTANT PROPERTIES</div>
    <Field label="kinematic viscosity" value={c.nu} set={set("nu")} unit="m²/s" />
    <Field label="density" value={c.density} set={set("density")} unit="kg/m³" />
    <Field label="Prandtl number" value={c.pr} set={set("pr")} />
    <Field label="conductivity k" value={c.conductivity} set={set("conductivity")} unit="W/m·K" />
    <Field label="expansion β" value={c.beta} set={set("beta")} unit="1/K" />
    <label className="sim-value"><span>boiling point</span><span><input aria-label="boiling point" type="number" step="any" placeholder="not set" value={c.boilingPoint ?? ""} onChange={e => { const next: ParallelChannelsCase = { ...c }; if (e.target.value === "") delete next.boilingPoint; else if (Number.isFinite(e.target.valueAsNumber)) next.boilingPoint = e.target.valueAsNumber; change(next); }} /><i>K</i></span></label>
    <div className="sim-section-title">PHYSICS</div>
    <label className="sim-value"><span>gravity</span><select aria-label="Gravity" value={c.gravity} onChange={e => set("gravity")(e.target.value as ParallelChannelsCase["gravity"])}>{(["off", "stacked", "upflow", "downflow"] as const).map(g => <option key={g} value={g}>{gravityLabel[g]}</option>)}</select></label>
    <p>Transient and laminar from rest: the inlet flow and the heating start at t = 0. buoyantBoussinesqPimpleFoam, with buoyancy through β when gravity is on; viscosity and conductivity stay constant. The solver never boils; the boiling point only feeds the checks.</p>
  </>;
}

/** Cell size at a cell centre, from the block layout. */
function cellBox(c: ParallelChannelsCase, x: number, y: number) {
  const L = parallelLayout(c), inChannel = x > c.manifoldLength && x < c.manifoldLength + c.channelLength;
  const layer = L.channelBottoms.findIndex(b => y >= b && y <= b + c.channelHeight);
  return { w: inChannel ? c.channelLength / c.cellsAlong : c.manifoldLength / L.manifoldCells, h: layer >= 0 ? c.channelHeight / c.cellsAcross : c.wallThickness / L.wallCells };
}

/** The device drawn to proportion along x and enlarged across; cells coloured by the chosen field once solved. */
export function ParallelDrawing({ config: c, fields, field }: { config: ParallelChannelsCase; fields: SimulationFields | null; field: "velocity" | "pressure" | "temperature" }) {
  const [hover, setHover] = useState<number | null>(null);
  const L = parallelLayout(c), total = 2 * c.manifoldLength + c.channelLength, x0 = 120, y0 = 150, w = 760, h = Math.max(150, Math.min(320, w * L.height / total));
  const X = (x: number) => x0 + x / total * w, Y = (y: number) => y0 + h - y / L.height * h, sx = w / total, sy = h / L.height, v = fields?.[field];
  // Heated walls leave a thin layer of cells far hotter than the rest; colours clip at the 98th percentile so the plume stays visible. Hover shows each cell's value.
  const sorted = v ? Float64Array.from(v).sort() : null, lo = sorted ? sorted[0]! : 0, top = sorted ? sorted[sorted.length - 1]! : 1, hi = sorted ? sorted[Math.floor(0.98 * (sorted.length - 1))]! : 1, clipped = hi < top;
  const unit = field === "velocity" ? "m/s" : field === "pressure" ? "Pa" : "K";
  const color = (n: number) => `hsl(208 32% ${24 + 66 * (hi === lo ? .5 : Math.min(1, (n - lo) / (hi - lo)))}%)`;
  const a = c.manifoldLength, b = a + c.channelLength, [gx, gy] = c.gravity === "stacked" ? [0, 1] : c.gravity === "upflow" ? [-1, 0] : c.gravity === "downflow" ? [1, 0] : [0, 0];
  return <div className="sim-drawing"><svg viewBox={`0 0 1000 ${y0 + h + 110}`} role="img" aria-label={fields ? `${field} computed on ${fields.centres.length} cells` : `${c.channels.length} channels ${number(c.channelHeight * 1000)} mm high and ${number(c.channelLength * 1000)} mm long between manifolds`}>
    {fields ? fields.centres.map((p, i) => { const box = cellBox(c, p[0], p[1]); return <rect key={i} x={X(p[0] - box.w / 2)} y={Y(p[1] + box.h / 2)} width={box.w * sx + .3} height={box.h * sy + .3} fill={color(v![i]!)} shapeRendering="crispEdges" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}><title>{`${number(v![i]!)} ${unit} · x ${number(p[0] * 1000)} mm · y ${number(p[1] * 1000)} mm`}</title></rect>; })
      : <>{[[0, a], [b, total]].map(([from, to]) => <rect key={from} className="sim-fluid" x={X(from!)} y={Y(L.height)} width={(to! - from!) * sx} height={h} />)}{L.channelBottoms.map(y => <rect key={y} className="sim-fluid" x={X(a)} y={Y(y + c.channelHeight)} width={c.channelLength * sx} height={c.channelHeight * sy} />)}</>}
    {L.channelBottoms.slice(1).map(y => <rect key={y} x={X(a)} y={Y(y)} width={c.channelLength * sx} height={c.wallThickness * sy} fill="var(--surface-3)" stroke="var(--line-2)" />)}
    {c.channels.map((ch, k) => { const y = L.channelBottoms[k]!; return <g key={k} className="sim-boundary"><path d={`M${X(a)} ${Y(y)}H${X(b)}M${X(a)} ${Y(y + c.channelHeight)}H${X(b)}`} style={ch.heatFlux > 0 ? { stroke: "var(--warn)", strokeWidth: 3 } : undefined} /><text x={X(a) + 8} y={Y(y + c.channelHeight / 2) + 4} style={halo}>{k + 1}{ch.heatFlux > 0 ? ` · ${number(ch.heatFlux / 1e4)} W/cm²` : ""}</text></g>; })}
    <g className="sim-boundary"><path d={`M${X(0)} ${Y(0)}v${-h}M${x0 - 90} ${Y(L.height / 2)}h70l-8 -5m8 5l-8 5`} /><text x={x0 - 95} y={Y(L.height / 2) - 14}>INLET</text><text x={x0 - 95} y={Y(L.height / 2) + 24}>{number(c.velocity)} m/s</text><text x={x0 - 95} y={Y(L.height / 2) + 40}>{c.inletTemperature} K</text></g>
    <g className="sim-boundary"><path d={`M${X(total)} ${Y(0)}v${-h}M${X(total) + 12} ${Y(L.height / 2)}h60l-8 -5m8 5l-8 5`} /><text x={X(total) + 12} y={Y(L.height / 2) - 14}>OUTLET</text><text x={X(total) + 12} y={Y(L.height / 2) + 24}>0 Pa</text></g>
    {(gx || gy) ? <g className="sim-dimensions"><path d={`M${x0 + w / 2 - 40 * gx} ${y0 - 60 - 20 * gy}l${40 * gx} ${40 * gy}m${-6 * gy - 4 * gx} ${-6 * gx - 4 * gy}l${6 * gy + 4 * gx} ${6 * gx + 4 * gy}l${4 * gx - 6 * gy} ${4 * gy - 6 * gx}`} /><text x={x0 + w / 2 + 16} y={y0 - 50}>g</text></g> : <text className="sim-scale-note" x={x0 + w / 2} y={y0 - 50} textAnchor="middle">gravity off</text>}
    <g className="sim-dimensions"><path d={`M${X(a)} ${y0 + h + 20}v30m0 -10H${X(b)}m0 -20v30`} /><text x={(X(a) + X(b)) / 2} y={y0 + h + 42} textAnchor="middle">{number(c.channelLength * 1000)} mm</text></g>
    <text className="sim-scale-note" x={x0} y={y0 + h + 80}>Vertical scale enlarged {Number((h / (w * L.height / total)).toPrecision(2))}× · planar section · channel 1 at the bottom</text>
  </svg>{v && <div className="sim-legend"><span>{number(lo)} {unit}</span><i style={{ background: `linear-gradient(90deg,${color(lo)},${color(hi)})` }} /><span>{number(hi)}{clipped ? "+" : ""} {unit}</span><span>{hover !== null ? `cell ${hover + 1} · ${number(v[hover]!)} ${unit}` : clipped ? `Cell-centred field · top 2 % of cells, up to ${number(top)} ${unit}, drawn at the top colour` : "Cell-centred field"}</span></div>}</div>;
}

/** Each channel's flow over the run, against an even split. A flow below zero runs backwards. */
export function FlowHistoryPlot({ config: c, results: r }: { config: ParallelChannelsCase; results: ParallelChannelsResults }) {
  const end = Math.max(...r.history.map(p => p.time), c.duration), all = r.history.flatMap(p => p.flows), even = r.inflow / c.channels.length;
  // Zoom on the flows and the even split; a range pinned at zero would flatten a 57/43 split into two near-parallel lines.
  const lo = Math.min(even, ...all), hi = Math.max(even, ...all), pad = Math.max(0.1 * (hi - lo), 0.05 * even), bottom = lo - pad, top = hi + pad;
  const tick = (q: number) => String(Number((q * 1e4).toPrecision(3))), x = (t: number) => 60 + t / end * 690, y = (q: number) => 250 - (q - bottom) / (top - bottom) * 220, last = r.history.at(-1);
  return <div className="sim-residuals"><svg viewBox="0 0 800 290" role="img" aria-label={`Flow through each channel over ${number(end)} s; at the end ${r.flows.map((q, k) => `${channelName(c, k)} ${percent(q / r.inflow)}`).join(", ")} of the inflow`}>
    {bottom < 0 && <><path d={`M60 ${y(0)}H750`} stroke="var(--line-2)" /><text x="8" y={y(0) + 4}>0</text><text x="66" y={y(0) + 16}>reversed below</text></>}
    <text x="8" y={y(top) + 4}>{tick(top)}</text><text x="8" y={y(bottom) + 4}>{tick(bottom)}</text>
    <path d={`M60 ${y(even)}H750`} stroke="var(--ink-3)" strokeDasharray="2 5" /><text x="8" y={y(even) + 4}>{tick(even)}</text><text x="66" y={y(even) - 6}>even split</text>
    {c.channels.map((_, k) => <g key={k}><polyline points={r.history.map(p => `${x(p.time)},${y(p.flows[k]!)}`).join(" ")} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray={dashes[k]} />{last && <text x={x(last.time) + 6} y={y(last.flows[k]!) + 4} style={{ fill: "var(--ink)" }}>{k + 1}</text>}</g>)}
    <text x="60" y="276">0 s</text><text x="405" y="276" textAnchor="middle">FLOW PER CHANNEL · cm²/s per unit depth</text><text x="750" y="276" textAnchor="end">{number(end)} s</text>
  </svg></div>;
}

/** Results rail: how the flow divided, what each channel delivers, the hottest heated wall and where the heat went. */
export function ParallelMeasurements({ config: c, report }: { config: ParallelChannelsCase; report: SimulationReport | null }) {
  const r = report?.parallel, fact = (label: string, value: string, tone?: string) => <div className={`sim-value${tone ? ` sim-measure ${tone}` : ""}`} key={label}><span>{label}</span><span>{value}</span></div>;
  if (!r) return <>{fact("physical time", report?.physicalTime == null ? "—" : `${number(report.physicalTime)} s`)}<p>Flows, temperatures and the energy balance appear after a solve is exported.</p></>;
  const carried = r.heatInputW > 0 ? r.heatCarriedOutW / r.heatInputW : null, wall = r.maxHeatedWallTemperatureK;
  return <>
    {fact("physical time", `${number(report!.physicalTime ?? 0)} s`)}{fact("inflow", flow(r.inflow))}
    {r.flows.map((q, k) => fact(channelName(c, k), `${percent(q / r.inflow)} · ${flow(q)}`, q < 0 ? "fail" : undefined))}
    {r.exitBulkTemperaturesK.map((t, k) => fact(`exit bulk T · ${k + 1}`, t == null ? "no net flow" : celsius(t)))}
    {wall != null && fact("hottest heated wall", celsius(wall), c.boilingPoint !== undefined && wall >= c.boilingPoint ? "fail" : undefined)}
    {wall != null && c.boilingPoint !== undefined && fact(wall < c.boilingPoint ? "below Tsat" : "above Tsat", `${number(Math.abs(c.boilingPoint - wall))} K`, wall >= c.boilingPoint ? "fail" : undefined)}
    {carried !== null && fact("heat carried out", `${percent(carried)} of ${number(r.heatInputW)} W/m`, carried < .9 ? "warn" : undefined)}
    <p>Flows are the solver's face fluxes through each channel's mid-length, per metre of depth. Exit bulk temperatures weight each face where fluid leaves a channel by its flux; a channel running backwards leaves through its upstream end. {carried !== null && carried < .9 ? "Most of the heat is still warming the fluid, so the device has not reached a thermal steady state and the flow split can still change." : carried !== null ? "The outlet carries away about what the walls put in, as at a steady state." : ""}</p>
  </>;
}
