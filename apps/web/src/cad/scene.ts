import { AmbientLight, AxesHelper, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, EdgesGeometry, GridHelper, Group, Line, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, PerspectiveCamera, Plane, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CadModel } from "./model";

export type View = "iso" | "front" | "right" | "top";
export type Display = "shaded" | "edges" | "wire";
export type DisplayOptions = { display: Display; grid: boolean; selected: number | null; hidden: number[]; section: "off" | "x" | "y" | "z"; slice: number; measure: boolean };
/** Two points on the model, in the model's own units, and the straight-line distance between them. */
export type Measurement = { a: Vector3; b: Vector3 | null; distance: number | null };
export function modelBounds(model: CadModel) {
  const box = new Box3();
  for (const mesh of model.meshes) for (let i = 0; i < mesh.positions.length; i += 3) box.expandByPoint(new Vector3(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!));
  return box;
}

export function createScene(host: HTMLElement, model: CadModel | null, select: (part: number | null) => void, fail: (message: string) => void, measured: (m: Measurement | null) => void = () => {}) {
  const bounds = model ? modelBounds(model) : null;
  const size = bounds?.getSize(new Vector3()) ?? new Vector3(2, 2, 0), center = bounds?.getCenter(new Vector3()) ?? new Vector3();
  const span = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(span) || span <= 0) throw new Error("This model has no visible extent.");
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.localClippingEnabled = true;
  renderer.domElement.setAttribute("aria-label", "Interactive CAD viewport. Drag to orbit, right-drag to pan, scroll to zoom. Use the view buttons for keyboard navigation.");
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);
  const scene = new Scene(), group = new Group(); scene.add(group);
  scene.add(new AmbientLight(0xffffff, 1.6));
  const key = new DirectionalLight(0xffffff, 3); key.position.set(3, -4, 6); scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.9); fill.position.set(-4, 2, 1); scene.add(fill);
  const camera = new PerspectiveCamera(38, 1, 0.01, 100); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement); controls.minDistance = 0.15; controls.maxDistance = 40;
  const clip = new Plane();
  const meshes = (model?.meshes ?? []).map((part, index) => {
    const geometry = new BufferGeometry();
    // Center/scale a copy for GPU precision. Original coordinates remain in the immutable preview.
    const positions = part.positions.slice();
    for (let i = 0; i < positions.length; i += 3) { positions[i] = (positions[i]! - center.x) / span * 2; positions[i + 1] = (positions[i + 1]! - center.y) / span * 2; positions[i + 2] = (positions[i + 2]! - center.z) / span * 2; }
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    if (part.indices) geometry.setIndex(new BufferAttribute(part.indices, 1));
    if (part.normals) geometry.setAttribute("normal", new BufferAttribute(part.normals, 3)); else geometry.computeVertexNormals();
    const color = part.color ? new Color().setRGB(...part.color) : new Color(0xc9ccd2);
    const material = new MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.72, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const mesh = new Mesh(geometry, material); mesh.userData.part = index; group.add(mesh);
    // feature edges, drawn as hairlines over the shaded part in "edges" display
    const outline = new LineSegments(new EdgesGeometry(geometry, 28), new LineBasicMaterial({ color: 0xe9ebef, transparent: true, opacity: 0.55 })); outline.visible = false; mesh.add(outline);
    return mesh;
  });
  const grid = new GridHelper(5, 20, 0x3a3e46, 0x24272d); grid.rotation.x = Math.PI / 2; grid.position.z = model ? -size.z / span - 0.012 : 0;
  const gridMaterial = grid.material; gridMaterial.transparent = true; gridMaterial.opacity = 0.6; scene.add(grid);
  const axes = new AxesHelper(0.55); axes.setColors(new Color(0xb4b8bf), new Color(0x858a93), new Color(0x55b6e0)); axes.position.set(model ? -1.8 : 0, model ? -1.8 : 0, grid.position.z); scene.add(axes);
  let dead = false;
  function render() { if (!dead && host.clientWidth && host.clientHeight) renderer.render(scene, camera); }
  function resize() {
    const width = host.clientWidth, height = host.clientHeight; if (!width || !height) return;
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
  }
  function view(view: View) {
    controls.target.set(0, 0, 0);
    const distance = 1.9 / Math.sin(camera.fov * Math.PI / 360) / Math.min(1, camera.aspect);
    camera.up.set(0, view === "top" ? 1 : 0, view === "top" ? 0 : 1);
    const direction = view === "top" ? new Vector3(0, 0, 1) : view === "front" ? new Vector3(0, -1, 0) : view === "right" ? new Vector3(1, 0, 0) : new Vector3(1, -1.4, 1);
    camera.position.copy(direction.normalize().multiplyScalar(Math.min(30, distance))); controls.update(); render();
  }
  const raycaster = new Raycaster(); let down = { x: 0, y: 0 };
  let measuring = false, first: Vector3 | null = null;
  const toModel = (p: Vector3) => new Vector3(p.x * span / 2 + center.x, p.y * span / 2 + center.y, p.z * span / 2 + center.z);
  const tape = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]), new LineBasicMaterial({ color: 0x55b6e0, depthTest: false })); tape.renderOrder = 2; tape.visible = false; scene.add(tape);
  const pins = [0, 1].map(() => { const pin = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0x55b6e0, emissive: 0x55b6e0, emissiveIntensity: 0.8, depthTest: false })); pin.renderOrder = 3; pin.visible = false; scene.add(pin); return pin; });
  const pinShape = () => { const g = new BufferGeometry(); const r = 0.012; g.setAttribute("position", new BufferAttribute(new Float32Array([-r, -r, 0, r, -r, 0, r, r, 0, -r, -r, 0, r, r, 0, -r, r, 0]), 3)); g.computeVertexNormals(); return g; };
  for (const pin of pins) pin.geometry = pinShape();
  function clearMeasure() { first = null; tape.visible = false; for (const pin of pins) pin.visible = false; measured(null); render(); }
  const pointerDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const pointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(meshes.filter(m => m.visible), false).find(h => !(h.object as Mesh<BufferGeometry, MeshStandardMaterial>).material.clippingPlanes?.length || clip.distanceToPoint(h.point) >= 0);
    if (measuring) {
      if (!hit) return;
      if (!first) { first = hit.point.clone(); pins[0]!.position.copy(first); pins[0]!.lookAt(camera.position); pins[0]!.visible = true; tape.visible = false; pins[1]!.visible = false; measured({ a: toModel(first), b: null, distance: null }); render(); return; }
      const second = hit.point.clone(); pins[1]!.position.copy(second); pins[1]!.lookAt(camera.position); pins[1]!.visible = true;
      tape.geometry.setFromPoints([first, second]); tape.visible = true;
      const a = toModel(first), b = toModel(second); measured({ a, b, distance: a.distanceTo(b) }); first = null; render(); return;
    }
    select(hit ? hit.object.userData.part as number : null);
  };
  const contextLost = (event: Event) => { event.preventDefault(); fail("The graphics context was lost. Reload the viewer to continue."); };
  renderer.domElement.addEventListener("pointerdown", pointerDown); renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  controls.addEventListener("change", render);
  const observer = new ResizeObserver(resize); observer.observe(host); resize(); view("iso");
  return {
    view, clearMeasure,
    zoom(factor: number) { const offset = camera.position.clone().sub(controls.target); offset.setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() * factor))); camera.position.copy(controls.target).add(offset); controls.update(); render(); },
    update(options: DisplayOptions) {
      clip.normal.set(options.section === "x" ? -1 : 0, options.section === "y" ? -1 : 0, options.section === "z" ? -1 : 0); clip.constant = options.slice;
      for (const [i, mesh] of meshes.entries()) {
        mesh.visible = !options.hidden.includes(i); mesh.material.wireframe = options.display === "wire";
        mesh.material.emissive.setHex(options.selected === i ? 0x35383f : 0); mesh.material.clippingPlanes = options.section === "off" ? [] : [clip];
        const outline = mesh.children[0] as LineSegments<EdgesGeometry, LineBasicMaterial>; outline.visible = options.display === "edges"; outline.material.clippingPlanes = mesh.material.clippingPlanes;
      }
      if (measuring !== options.measure) { measuring = options.measure; if (!measuring) clearMeasure(); }
      grid.visible = axes.visible = options.grid; render();
    },
    dispose() {
      dead = true; observer.disconnect(); controls.removeEventListener("change", render); controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp); renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      for (const mesh of meshes) { const outline = mesh.children[0] as LineSegments<EdgesGeometry, LineBasicMaterial>; outline.geometry.dispose(); outline.material.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
      tape.geometry.dispose(); tape.material.dispose(); for (const pin of pins) { pin.geometry.dispose(); pin.material.dispose(); }
      grid.geometry.dispose(); gridMaterial.dispose(); axes.geometry.dispose(); for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) material.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
