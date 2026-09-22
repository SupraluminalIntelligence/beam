import { useEffect, useMemo, useRef, useState } from "react";
import { Box3, Vector3 } from "three";
import { createScene, modelBounds, type Display, type DisplayOptions, type Measurement, type View } from "./scene";
import { triangleCount, type CadModel } from "./model";

const initial: DisplayOptions = { display: "shaded", grid: true, selected: null, hidden: [], section: "off", slice: 0, measure: false };
const VIEWS: [View, string][] = [["iso", "iso"], ["front", "front"], ["right", "right"], ["top", "top"]];
const DISPLAYS: [Display, string][] = [["shaded", "shaded"], ["edges", "edges"], ["wire", "wire"]];
const NB = " "; // narrow no-break space between a number and its unit

/** A square that reads as a state: hollow = off or hidden, filled = on. Sits in the toolbar and the parts rail. */
const Sq = ({ on, live = false }: { on: boolean; live?: boolean }) => <span className={`sq${live ? " work" : on ? " ok" : ""}`} aria-hidden="true" />;
const Seg = <T extends string>({ value, options, onChange, label, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; disabled?: boolean }) =>
  <span className="seg cad-seg" role="group" aria-label={label}>{options.map(([v, text]) => <button key={v} className={value === v ? "on" : ""} aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>{text}</button>)}</span>;

export function CadViewer({ model, name }: { model: CadModel | null; name: string }) {
  const host = useRef<HTMLDivElement>(null), scene = useRef<ReturnType<typeof createScene> | null>(null);
  const [options, setOptions] = useState(initial), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [view, setView] = useState<View>("iso"), [rail, setRail] = useState(true), [measurement, setMeasurement] = useState<Measurement | null>(null);
  const size = useMemo(() => model ? modelBounds(model).getSize(new Vector3()) : null, [model]);
  const partSizes = useMemo(() => model?.meshes.map(m => { const box = new Box3(); for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(new Vector3(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!)); return box.getSize(new Vector3()); }) ?? [], [model]);
  const triangles = useMemo(() => model ? triangleCount(model) : 0, [model]);
  useEffect(() => {
    setOptions(initial); setError(""); setView("iso"); setMeasurement(null);
    try { scene.current = createScene(host.current!, model, selected => setOptions(o => ({ ...o, selected })), setError, setMeasurement); }
    catch (e) { setError(e instanceof Error ? e.message : "3D graphics are unavailable on this device."); }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, [model, revision]);
  useEffect(() => { scene.current?.update(options); }, [options]);
  useEffect(() => {
    if (!options.measure) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOptions(o => ({ ...o, measure: false })); } };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  }, [options.measure]);
  const unit = model?.unit === "mm" ? "mm" : "u";
  const n = (v: number) => v.toLocaleString(undefined, { maximumSignificantDigits: 5 });
  const q = (v: number) => `${n(v)}${NB}${unit}`;
  const selected = options.selected !== null ? model?.meshes[options.selected] ?? null : null;
  const selectedSize = options.selected !== null ? partSizes[options.selected] ?? null : null;
  const half = size ? Math.max(size.x, size.y, size.z) / 2 : 1;
  const go = (v: View) => { scene.current?.view(v); setView(v); };
  return <div className="cad-viewer">
    <div className="cad-toolbar" role="toolbar" aria-label="Model view controls">
      <Seg value={view} options={VIEWS} onChange={go} label="View" />
      <button className="cad-k fit" onClick={() => go(view)} title="Fit the model">fit</button>
      <button className="cad-k zoom" aria-label="Zoom in" onClick={() => scene.current?.zoom(0.8)}>+</button>
      <button className="cad-k zoom" aria-label="Zoom out" onClick={() => scene.current?.zoom(1.25)}>−</button>
      <span className="sp" />
      <Seg value={options.display} options={DISPLAYS} onChange={display => setOptions(o => ({ ...o, display }))} label="Display" disabled={!model} />
      <button className="cad-k cad-tog" aria-pressed={options.grid} onClick={() => setOptions(o => ({ ...o, grid: !o.grid }))}><Sq on={options.grid} />grid</button>
      <button className={`cad-k cad-tog${options.measure ? " live" : ""}`} aria-pressed={options.measure} disabled={!model} onClick={() => setOptions(o => ({ ...o, measure: !o.measure }))} title="Click two points on the model"><Sq on={options.measure} live={options.measure} />measure</button>
      <button className="cad-k cad-tog rail-tog" aria-pressed={rail} aria-controls="cad-rail" onClick={() => setRail(!rail)}><Sq on={rail} />rail</button>
    </div>
    <div className="cad-body">
      <div className="cad-stage">
        <div className={`cad-canvas${options.measure ? " measuring" : ""}`} ref={host} />
        {model && <div className="cad-corner tl"><span>parts <b>{model.meshes.length}</b></span><span>tris <b>{triangles.toLocaleString()}</b></span>{options.section !== "off" && <span>{options.section} section <b>{q(options.slice * half)}</b></span>}</div>}
        {options.measure && <div className="cad-corner tr live">{measurement?.distance != null ? <span>measure <b>{q(measurement.distance)}</b></span> : measurement ? <span>second point</span> : <span>first point</span>}</div>}
        <div className="cad-corner bl">{model ? <>Fig. — {name || "model"}, {view}{options.section !== "off" ? `, section ${options.section}${NB}=${NB}${q(options.slice * half)}` : ""}</> : "No model · drop a file or open one"}</div>
        <div className="cad-corner br">{options.measure ? "click two points · esc" : "drag orbit · right-drag pan · scroll zoom"}</div>
        {error && <div className="cad-graphics-error" role="alert"><b>Couldn’t display the model</b><p>{error}</p><button className="btn" onClick={() => setRevision(r => r + 1)}>Reload viewer</button></div>}
      </div>
      {rail && <aside className="cad-rail" id="cad-rail" aria-label="Model controls">
        <div className="cad-rh"><span>Parts</span><span>{model?.meshes.length ?? 0}</span></div>
        {model?.meshes.map((mesh, i) => {
          const hidden = options.hidden.includes(i), on = options.selected === i;
          return <div key={i} className={`cad-row${on ? " on" : ""}${hidden ? " hidden" : ""}`}>
            <button className="cad-vis" aria-label={`${hidden ? "Show" : "Hide"} ${mesh.name}`} aria-pressed={!hidden} onClick={() => setOptions(o => ({ ...o, hidden: hidden ? o.hidden.filter(x => x !== i) : [...o.hidden, i], selected: !hidden && o.selected === i ? null : o.selected }))}><Sq on={!hidden} /></button>
            <button className="cad-nm" aria-pressed={on} onClick={e => setOptions(o => e.altKey ? { ...o, selected: i, hidden: model.meshes.map((_, k) => k).filter(k => k !== i) } : { ...o, selected: on ? null : i })}>{mesh.name}</button>
            <span className="cad-meta">{((mesh.indices?.length ?? mesh.positions.length / 3) / 3).toLocaleString()}</span>
          </div>;
        })}
        {model && <div className="cad-note">{options.hidden.length ? <button className="cad-k" onClick={() => setOptions(o => ({ ...o, hidden: [] }))}>show all</button> : <>click hides · ⌥click isolates</>}</div>}
        <div className="cad-rh"><span>Section</span>{options.section !== "off" && <span>visual cut</span>}</div>
        <div className="cad-sec">
          <Seg value={options.section} options={[["off", "off"], ["x", "x"], ["y", "y"], ["z", "z"]]} onChange={section => setOptions(o => ({ ...o, section }))} label="Section plane" disabled={!model} />
          {options.section !== "off" && <span className="cad-val">{q(options.slice * half)}</span>}
        </div>
        {options.section !== "off" && <>
          <input className="cad-range" type="range" aria-label="Section position" min={-1.01} max={1.01} step={0.01} value={options.slice} onChange={e => setOptions(o => ({ ...o, slice: Number(e.target.value) }))} />
          <div className="cad-ends"><span>−{n(half)}</span><span>+{n(half)}</span></div>
        </>}
        <div className="cad-rh"><span>Bounds</span><span>{selected ? "selected" : "model"}</span></div>
        {size && <div className="cad-kv">
          {(["x", "y", "z"] as const).map(axis => <div key={axis}><span>{axis}</span><span>{q((selectedSize ?? size)[axis])}</span></div>)}
          {selectedSize && <div className="cad-dim"><span>of</span><span>{q(size.x)} · {q(size.y)} · {q(size.z)}</span></div>}
        </div>}
        {measurement?.distance != null && <>
          <div className="cad-rh"><span>Measure</span><button className="cad-k" onClick={() => scene.current?.clearMeasure()}>clear</button></div>
          <div className="cad-kv">
            <div><span>distance</span><span>{q(measurement.distance)}</span></div>
            {measurement.b && (["x", "y", "z"] as const).map(axis => <div key={axis}><span>Δ{axis}</span><span>{q(Math.abs(measurement.b![axis] - measurement.a[axis]))}</span></div>)}
          </div>
        </>}
        <div className="cad-note">{model ? "tessellated preview, not B-rep" : "STEP · IGES · STL · OBJ"}</div>
      </aside>}
    </div>
    <div className="cad-status">
      {model && size ? <>
        <span>x <b>{q(size.x)}</b></span><span>y <b>{q(size.y)}</b></span><span>z <b>{q(size.z)}</b></span>
        <span className="sp" />
        {selected && <span className="shrink">selected <b>{selected.name}</b>{selectedSize && <> · {q(selectedSize.x)} · {q(selectedSize.y)} · {q(selectedSize.z)}</>}</span>}
        {measurement?.distance != null && <span className="live">measure <b>{q(measurement.distance)}</b></span>}
        <span>tris <b>{triangles.toLocaleString()}</b></span>
      </> : <><span>no model</span><span className="sp" /><span>STEP · IGES · STL · OBJ · 20{NB}MB</span></>}
    </div>
  </div>;
}
