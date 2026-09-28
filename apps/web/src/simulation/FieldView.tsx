import { useEffect, useMemo, useRef, useState } from "react";
import { BufferAttribute, BufferGeometry, DirectionalLight, DoubleSide, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, WireframeGeometry } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatQuantity, type ResultField, type ResultView } from "@beam/contracts";
import { load, nice, type Loaded, type Output } from "./fieldData";
import { wakeColor } from "./WakeViewer";

type Component = "magnitude" | 0 | 1 | 2;
type Three = { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; controls: OrbitControls; mesh: Mesh; wire: LineSegments | null };

/** Above this many triangles, reading a value follows a click rather than every mouse move, and the mesh overlay is off. */
const HOVER_TRIANGLES = 150_000;
const lut = (diverging: boolean) => Array.from({ length: 256 }, (_, i) => (wakeColor(i / 255, diverging).match(/\d+/g) ?? ["0", "0", "0"]).map(v => Number(v) / 255));
const PALETTES = { sequential: lut(false), diverging: lut(true) };
const gradient = (diverging: boolean) => `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(t => wakeColor(t, diverging)).join(", ")})`;
const AXIS = ["x", "y", "z"] as const;

/**
 * The 3D view of one field: its surface, coloured by an array, optionally deformed by a vector array
 * (exaggerated, and labelled so), stepped through its saved frames. Hovering reads the value at the
 * nearest vertex.
 */
export default function FieldView({ field, view, outputs, kept }: { field: ResultField; view: ResultView | undefined; outputs: Output[]; kept: string[] }) {
  const host = useRef<HTMLDivElement>(null), three = useRef<Three | null>(null);
  const [data, setData] = useState<Loaded | null>(null), [error, setError] = useState<string | null>(null);
  const urls = outputs.filter(o => o.path.startsWith("beam/out/preview/")).map(o => o.url).join("|");
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError(null);
    load(field, outputs, kept, abort.signal).then(setData, e => { if (!abort.signal.aborted) setError((e as Error).message); });
    return () => abort.abort();
  }, [field.preview, urls]);

  const arrays = data?.preview.arrays ?? [];
  const vectors = arrays.filter(a => a.components === 3);
  const [color, setColor] = useState<string | null>(null), [component, setComponent] = useState<Component>("magnitude");
  const [warp, setWarp] = useState<string | null>(null), [exponent, setExponent] = useState<number | null>(null);
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false), [wire, setWire] = useState(false), [clip, setClip] = useState(false);
  const [probe, setProbe] = useState<{ value: number; vertex: number } | null>(null);
  useEffect(() => {
    if (!data) return;
    const names = data.preview.arrays.map(a => a.name);
    setColor(view?.color && names.includes(view.color) ? view.color : data.preview.arrays.find(a => a.components === 1)?.name ?? names[0] ?? null);
    setWarp(view?.warp && data.preview.arrays.find(a => a.name === view.warp)?.components === 3 ? view.warp : null);
    setComponent("magnitude"); setExponent(null); setFrame(0);
  }, [data]);

  const frames = data?.preview.steps?.saved ?? 1, V = data?.preview.vertices ?? 0;
  const shown = arrays.find(a => a.name === color) ?? null, warped = vectors.find(a => a.name === warp) ?? null;
  // Scene units: centred on the undeformed surface and scaled to unit size, for precision on the GPU.
  const frameOf = useMemo(() => {
    if (!data) return null;
    const p = data.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[i + k]!); hi[k] = Math.max(hi[k]!, p[i + k]!); }
    const centre = lo.map((l, k) => (l + hi[k]!) / 2), size = Math.max(...hi.map((h, k) => h - lo[k]!)) || 1;
    return { centre, size, diagonal: Math.hypot(...hi.map((h, k) => h - lo[k]!)) || 1, half: hi.map((h, k) => (h - lo[k]!) / 2 / size) };
  }, [data]);
  // Deformation is exaggerated by default so it can be seen: the largest displacement is drawn as 8% of the part.
  const auto = useMemo(() => {
    if (!warped || !frameOf) return 1;
    const max = warped.range[1];
    return max > 0 ? Math.max(1, nice(0.08 * frameOf.diagonal / max)) : 1;
  }, [warped, frameOf]);
  const scale = exponent === null ? auto : 10 ** exponent;
  const valueAt = (a: NonNullable<typeof shown>, values: Float32Array, v: number, f: number) => {
    const at = (f * V + v) * a.components;
    if (a.components === 1) return values[at]!;
    return component === "magnitude" ? Math.hypot(values[at]!, values[at + 1]!, values[at + 2]!) : values[at + component]!;
  };
  // The legend's range: the preview's own for a scalar or a magnitude, measured over every frame for a component.
  // Clipped, it spans the 2nd to 98th percentile of this frame, so a singular peak does not wash out the rest.
  const range = useMemo((): { lo: number; hi: number; diverging: boolean } | null => {
    if (!shown || !data) return null;
    if (clip) {
      const values = data.arrays.get(shown.name)!, f = Math.min(frame, frames - 1), sorted = new Float32Array(V);
      for (let v = 0; v < V; v++) sorted[v] = valueAt(shown, values, v, f);
      sorted.sort();
      const lo = sorted[Math.floor(0.02 * (V - 1))]!, hi = sorted[Math.ceil(0.98 * (V - 1))]!;
      return { lo, hi, diverging: lo < 0 && hi > 0 };
    }
    if (shown.components === 1 || component === "magnitude") return { lo: shown.range[0], hi: shown.range[1], diverging: shown.range[0] < 0 && shown.range[1] > 0 };
    const values = data.arrays.get(shown.name)!;
    let m = 0;
    for (let i = component; i < values.length; i += 3) m = Math.max(m, Math.abs(values[i]!));
    return { lo: -m, hi: m, diverging: true };
  }, [shown, component, data, clip, clip ? frame : 0]);
  const symmetric = range?.diverging ? Math.max(Math.abs(range.lo), Math.abs(range.hi)) : null;

  // The renderer, once per field.
  useEffect(() => {
    const el = host.current;
    if (!el || !data || !frameOf) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError("WebGL is unavailable, so the 3D view cannot be drawn. Download the full data to open it in ParaView."); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", `${field.label}: interactive 3D view. Drag to orbit, right-drag to pan, scroll to zoom.`);
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new DirectionalLight(0xffffff, 1.6); key.position.set(2, -3, 4); scene.add(key);
    const camera = new PerspectiveCamera(35, 1, 0.005, 50);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.minDistance = 0.1; controls.maxDistance = 20;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(V * 3), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(V * 3), 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    // Flat shading takes each face's normal from screen-space derivatives, so faces whose winding is not
    // consistent (a surface cut from tetrahedra) still light correctly from both sides.
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, side: DoubleSide }));
    scene.add(mesh);
    const resize = () => { const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(el); resize();
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    three.current = { renderer, scene, camera, controls, mesh, wire: null };
    look("iso");
    return () => {
      observer.disconnect(); renderer.setAnimationLoop(null); controls.dispose();
      geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose();
      if (three.current?.wire) { three.current.wire.geometry.dispose(); (three.current.wire.material as LineBasicMaterial).dispose(); }
      renderer.dispose(); renderer.domElement.remove(); three.current = null;
    };
  }, [data, frameOf]);

  // Positions: the surface, plus the deformation at this frame times the exaggeration.
  useEffect(() => {
    const t = three.current;
    if (!t || !data || !frameOf) return;
    const out = t.mesh.geometry.getAttribute("position") as BufferAttribute, p = data.positions, { centre, size } = frameOf;
    const d = warped ? data.arrays.get(warped.name)! : null, base = Math.min(frame, frames - 1) * V * 3;
    for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) {
      const i = v * 3 + k;
      out.array[i] = (p[i]! + (d ? d[base + i]! * scale : 0) - centre[k]!) / size;
    }
    out.needsUpdate = true;
    t.mesh.geometry.computeBoundingSphere();
    if (t.wire) { t.scene.remove(t.wire); t.wire.geometry.dispose(); (t.wire.material as LineBasicMaterial).dispose(); t.wire = null; }
    if (wire && data.preview.triangles <= HOVER_TRIANGLES) {
      t.wire = new LineSegments(new WireframeGeometry(t.mesh.geometry), new LineBasicMaterial({ color: 0x0b1117, transparent: true, opacity: 0.35 }));
      t.scene.add(t.wire);
    }
  }, [data, frameOf, warped, scale, frame, wire]);

  // Colours: the chosen array at this frame through the palette; a plain surface when none is chosen.
  useEffect(() => {
    const t = three.current;
    if (!t || !data) return;
    const out = t.mesh.geometry.getAttribute("color") as BufferAttribute;
    if (!shown || !range) { (out.array as Float32Array).fill(0.82); out.needsUpdate = true; return; }
    const values = data.arrays.get(shown.name)!, f = Math.min(frame, frames - 1), palette = range.diverging ? PALETTES.diverging : PALETTES.sequential;
    const lo = symmetric !== null ? -symmetric : range.lo, span = (symmetric !== null ? 2 * symmetric : range.hi - range.lo) || 1;
    for (let v = 0; v < V; v++) {
      const c = palette[Math.max(0, Math.min(255, Math.round(((valueAt(shown, values, v, f) - lo) / span) * 255)))]!;
      out.setXYZ(v, c[0]!, c[1]!, c[2]!);
    }
    out.needsUpdate = true;
  }, [data, shown, component, range, frame]);

  // Playback through saved frames.
  useEffect(() => {
    if (!playing || frames < 2) return;
    const id = setInterval(() => setFrame(f => (f + 1) % frames), 1000 / 12);
    return () => clearInterval(id);
  }, [playing, frames]);

  function look(direction: "iso" | 0 | 1 | 2) {
    const t = three.current;
    if (!t) return;
    const dir = (direction === "iso" ? new Vector3(1.1, -1.7, 1.0) : new Vector3(...[0, 1, 2].map(k => (k === direction ? 1 : 0)) as [number, number, number])).normalize();
    // z up, except when looking down z.
    if (direction === 2) t.camera.up.set(0, 1, 0); else t.camera.up.set(0, 0, 1);
    // Close enough that the part's box, as seen from this direction, fills the view with a margin.
    const right = new Vector3().crossVectors(t.camera.up, dir).normalize(), up = new Vector3().crossVectors(dir, right);
    const tanV = Math.tan(((t.camera.fov / 2) * Math.PI) / 180), tanH = tanV * t.camera.aspect, h = frameOf?.half ?? [0.5, 0.5, 0.5];
    let distance = 0.2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const c = new Vector3(sx * h[0]!, sy * h[1]!, sz * h[2]!);
      distance = Math.max(distance, c.dot(dir) + Math.abs(c.dot(right)) / tanH, c.dot(dir) + Math.abs(c.dot(up)) / tanV);
    }
    t.camera.position.copy(dir.multiplyScalar(distance * 1.3)); // room for exaggerated deformation t.controls.target.set(0, 0, 0); t.controls.update();
  }

  // Reading a value: the nearest corner of the triangle under the pointer.
  const pointer = useRef<{ x: number; y: number } | null>(null), pending = useRef(false);
  const read = () => {
    pending.current = false;
    const t = three.current, at = pointer.current;
    if (!t || !at || !shown || !data) { setProbe(null); return; }
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(at.x, at.y), t.camera);
    const hit = ray.intersectObject(t.mesh)[0];
    if (!hit?.face) { setProbe(null); return; }
    const pos = t.mesh.geometry.getAttribute("position");
    const corners = [hit.face.a, hit.face.b, hit.face.c];
    const vertex = corners.reduce((best, v) => (new Vector3().fromBufferAttribute(pos, v).distanceTo(hit.point) < new Vector3().fromBufferAttribute(pos, best).distanceTo(hit.point) ? v : best), corners[0]!);
    setProbe({ vertex, value: valueAt(shown, data.arrays.get(shown.name)!, vertex, Math.min(frame, frames - 1)) });
  };
  const place = (e: React.MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    pointer.current = { x: ((e.clientX - box.left) / box.width) * 2 - 1, y: -((e.clientY - box.top) / box.height) * 2 + 1 };
  };
  const hover = (data?.preview.triangles ?? 0) <= HOVER_TRIANGLES;

  if (error) return <p className="results-empty">{error}</p>;
  if (!data || !frameOf) return <p className="results-empty">Loading the 3D view…</p>;
  const steps = data.preview.steps, unit = shown ? shown.unit : "";
  const label = shown ? `${shown.name}${shown.components === 3 ? component === "magnitude" ? " magnitude" : ` ${AXIS[component]}` : ""}` : "";
  return <div className="field-view">
    <div className="field-controls">
      <label>Colour <select value={color ?? ""} onChange={e => { setColor(e.target.value || null); setComponent("magnitude"); }}>
        <option value="">None</option>
        {arrays.map(a => <option key={a.name} value={a.name}>{a.name}{a.unit && a.unit !== "1" ? ` (${a.unit})` : ""}</option>)}
      </select></label>
      {shown?.components === 3 && <label>Component <select value={String(component)} onChange={e => setComponent(e.target.value === "magnitude" ? "magnitude" : (Number(e.target.value) as 0 | 1 | 2))}>
        <option value="magnitude">Magnitude</option>{AXIS.map((a, k) => <option key={a} value={k}>{a}</option>)}
      </select></label>}
      {vectors.length > 0 && <label>Deform by <select value={warp ?? ""} onChange={e => { setWarp(e.target.value || null); setExponent(null); }}>
        <option value="">Nothing</option>{vectors.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
      </select></label>}
      {warped && <label className="field-scale">×{formatQuantity(scale, "1", 3)}
        <input type="range" aria-label="Deformation scale" min={0} max={Math.max(1, Math.log10(auto) + 1)} step={0.01} value={Math.log10(scale)} onChange={e => setExponent(Number(e.target.value))} />
      </label>}
      <span className="field-look" role="group" aria-label="View direction">
        <button className="btn ghost" onClick={() => look("iso")}>Iso</button>
        {AXIS.map((a, k) => <button key={a} className="btn ghost" onClick={() => look(k as 0 | 1 | 2)}>{a}</button>)}
      </span>
      {shown && <label className="field-check" title="Colour the 2nd to 98th percentile, so a singular peak does not wash out the rest"><input type="checkbox" checked={clip} onChange={e => setClip(e.target.checked)} /> Clip 2–98%</label>}
      {data.preview.triangles <= HOVER_TRIANGLES && <label className="field-check"><input type="checkbox" checked={wire} onChange={e => setWire(e.target.checked)} /> Mesh</label>}
    </div>
    <div className="field-viewport" ref={host}
      onPointerMove={e => { place(e); if (hover && !pending.current) { pending.current = true; requestAnimationFrame(read); } }}
      onPointerLeave={() => { pointer.current = null; setProbe(null); }}
      onClick={e => { if (!hover) { place(e); read(); } }} />
    {steps && frames > 1 && <div className="field-steps">
      <button className="btn ghost" onClick={() => setPlaying(p => !p)}>{playing ? "Pause" : "Play"}</button>
      <input type="range" aria-label={`${steps.kind} step`} min={0} max={frames - 1} value={Math.min(frame, frames - 1)} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} />
      <span>{steps.kind} {steps.values[frame] !== undefined ? formatQuantity(steps.values[frame]!, steps.unit || "1") : frame + 1}{steps.saved < steps.total ? ` · ${steps.saved} of ${steps.total} saved` : ""}</span>
    </div>}
    <div className="field-legend">
      {shown && range ? <>
        <span>{label}</span>
        <span>{formatQuantity(symmetric !== null ? -symmetric : range.lo, unit)}</span><i style={{ background: gradient(range.diverging) }} /><span>{formatQuantity(symmetric !== null ? symmetric : range.hi, unit)}{clip ? " · clipped" : ""}</span>
      </> : <span>No colouring</span>}
      <span className="field-readout">{probe ? `${label} ${formatQuantity(probe.value, unit)}` : hover ? "Hover to read a value" : "Click to read a value"}</span>
    </div>
    <p className="field-note">
      {data.preview.triangles.toLocaleString("en-US")} surface triangles of {field.cells.toLocaleString("en-US")} cells
      {warped ? scale === 1 ? ` · deformation at true scale` : ` · deformation exaggerated ×${formatQuantity(scale, "1", 3)}, not to scale` : ""}
    </p>
  </div>;
}
