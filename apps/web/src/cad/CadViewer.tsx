import { useEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { createScene, modelBounds, type DisplayOptions, type View } from "./scene";
import { triangleCount, type CadModel } from "./model";

const initial: DisplayOptions = { wireframe: false, grid: true, selected: null, hidden: [], section: "off", slice: 0 };
export function CadViewer({ model, name }: { model: CadModel | null; name: string }) {
  const host = useRef<HTMLDivElement>(null), scene = useRef<ReturnType<typeof createScene> | null>(null);
  const [options, setOptions] = useState(initial), [error, setError] = useState(""), [revision, setRevision] = useState(0), [parts, setParts] = useState(false);
  const size = useMemo(() => model ? modelBounds(model).getSize(new Vector3()) : null, [model]);
  const triangles = useMemo(() => model ? triangleCount(model) : 0, [model]);
  useEffect(() => {
    setOptions(initial); setParts(false); setError("");
    try { scene.current = createScene(host.current!, model, selected => setOptions(o => ({ ...o, selected })), setError); }
    catch (e) { setError(e instanceof Error ? e.message : "3D graphics are unavailable on this device."); }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, [model, revision]);
  useEffect(() => { scene.current?.update(options); }, [options]);
  const number = (v: number) => v.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  return <div className="cad-viewer">
    <div className="cad-toolbar" role="toolbar" aria-label="Model view controls">
      <div className="cad-button-group">{([['iso', 'Fit'], ['front', 'Front'], ['right', 'Right'], ['top', 'Top']] as [View, string][]).map(([view, label]) => <button key={view} onClick={() => scene.current?.view(view)}>{label}</button>)}<button aria-label="Zoom in" onClick={() => scene.current?.zoom(0.8)}>＋</button><button aria-label="Zoom out" onClick={() => scene.current?.zoom(1.25)}>−</button></div>
      <div className="cad-button-group"><button disabled={!model} aria-pressed={options.wireframe} onClick={() => setOptions(o => ({ ...o, wireframe: !o.wireframe }))}>Wireframe</button><button aria-pressed={options.grid} onClick={() => setOptions(o => ({ ...o, grid: !o.grid }))}>Grid</button><button disabled={!model} aria-expanded={parts} onClick={() => setParts(!parts)}>Parts ({model?.meshes.length ?? 0})</button></div>
    </div>
    <div className="cad-stage">
      <div className="cad-canvas" ref={host} />
      {model && <div className="cad-model-label"><span>{model.format}</span><b>{name}</b></div>}
      {parts && model && <div className="cad-parts" aria-label="Model parts"><div><b>Parts</b><button onClick={() => setOptions(o => ({ ...o, hidden: [], selected: null }))}>Show all</button></div>{model.meshes.map((mesh, i) => <div key={i} className={options.selected === i ? "selected" : ""}><input type="checkbox" aria-label={`Show ${mesh.name}`} checked={!options.hidden.includes(i)} onChange={e => setOptions(o => ({ ...o, hidden: e.target.checked ? o.hidden.filter(n => n !== i) : [...o.hidden, i] }))} /><button aria-pressed={options.selected === i} onClick={() => setOptions(o => ({ ...o, selected: o.selected === i ? null : i }))}>{mesh.name}</button></div>)}</div>}
      {error && <div className="cad-graphics-error" role="alert"><b>Couldn’t display the model</b><p>{error}</p><button className="btn" onClick={() => setRevision(r => r + 1)}>Reload viewer</button></div>}
      <div className="cad-gesture-hint">Drag to orbit · Right-drag to pan · Scroll to zoom</div>
      {model && options.selected !== null && <div className="cad-selection"><b>{model.meshes[options.selected]?.name}</b><button onClick={() => setOptions(o => ({ ...o, hidden: model.meshes.map((_, i) => i).filter(i => i !== o.selected) }))}>Isolate</button><button onClick={() => setOptions(o => ({ ...o, selected: null, hidden: [] }))}>Clear</button></div>}
    </div>
    <div className="cad-section"><label>Section<select disabled={!model} aria-label="Section plane" value={options.section} onChange={e => setOptions(o => ({ ...o, section: e.target.value as DisplayOptions['section'] }))}><option value="off">Off</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>{options.section !== "off" && <><input type="range" aria-label="Section position" min={-1.01} max={1.01} step={0.01} value={options.slice} onChange={e => setOptions(o => ({ ...o, slice: Number(e.target.value) }))} /><span>Visual cut · uncapped</span></>}</div>
    <div className="cad-status">{model && size ? <><span title="Axis-aligned bounds of the tessellated preview">X {number(size.x)} · Y {number(size.y)} · Z {number(size.z)} <b>{model.unit}</b></span><span>{triangles.toLocaleString()} triangles</span></> : <><span>No model loaded · Drop a file or use Open model</span><span>STEP · IGES · STL · OBJ</span></>}</div>
  </div>;
}
