import { SimulationTabLabel, SimulationView } from "../simulation/Simulations";
import { lazy, Suspense, Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { emptyPanel, ui, useUi } from "../lib/ui";
import { ComputeJob } from "./Compute";
import { ContextPane } from "./Context";
import { BrowserStart, rememberBrowserUrl } from "../browser/BrowserStart";
import { normalizePreviewUrl } from "../vendor/t3code/previewUrl";
import { browserAction, useBrowserStatus } from "../browser/BrowserHost";
import { bridge } from "../bridge";

const CadPane = lazy(() => import("../cad/CadPane"));

const tools = [
  { id: "browser", label: "Browser", icon: "◎", group: "General", detail: "Open a web preview" },
  { id: "files", label: "Context", icon: "▤", group: "General", detail: "Files, links, and sources" },
  { id: "cad", label: "CAD Viewer", icon: "◇", group: "Engineering", detail: "Inspect models, parts, and sections" },
];
const MIN_TOOL_WIDTH = 340;
const MIN_CHAT_WIDTH = 480;
const label = (id: string) => tools.find(t=>t.id===id)?.label ?? (id.startsWith("job:") ? `Job · ${id.slice(-6)}` : id.startsWith("sim:") ? "Simulation" : "Tool");

/** Shared presentation shell. Durable resources and executions are owned outside it. */
export function WorkspacePane({ chatId, login }: { chatId: Id<"chats">; login: string }) {
  const panel = useUi().panels[chatId] ?? emptyPanel;
  const host = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailableWidth(parent.clientWidth);
    const observer = new ResizeObserver(measure);
    measure(); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const compact = availableWidth < MIN_TOOL_WIDTH + MIN_CHAT_WIDTH;
  const maxWidth = Math.max(MIN_TOOL_WIDTH, availableWidth - MIN_CHAT_WIDTH);
  const paneWidth = Math.min(maxWidth, Math.max(MIN_TOOL_WIDTH, panel.width));
  useEffect(() => {
    if (!panel.open || !panel.maximized) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      ui.panel(chatId, { maximized: false });
      host.current?.querySelector<HTMLButtonElement>(".workspace-expand")?.focus();
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [chatId, panel.open, panel.maximized]);
  const activate = (id:string)=>ui.openSurface(chatId,id);
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const measureStrip = () => {
    const el = strip.current;
    if (el) setOverflow({ start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  // The selected tool's tab is always in view, however many tabs the strip holds; hidden ones are a scroll away, with a fade to say so.
  const revealSelected = () => {
    const el = strip.current, tab = el?.querySelector<HTMLElement>(".workspace-tab.selected");
    if (el && tab) {
      // Clear of the fade, too.
      const box = el.getBoundingClientRect(), r = tab.getBoundingClientRect(), fade = 28;
      if (r.left < box.left + fade) el.scrollLeft -= box.left + fade - r.left;
      else if (r.right > box.right - fade) el.scrollLeft += r.right - (box.right - fade);
    }
    measureStrip();
  };
  useLayoutEffect(revealSelected, [panel.active, panel.tabs.length]);
  // Again whenever the strip or a tab changes size: the window or pane resizes, or a tab's label loads.
  const tabKey = panel.tabs.join("\n");
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(revealSelected);
    observer.observe(el);
    for (const tab of Array.from(el.children)) observer.observe(tab);
    return () => observer.disconnect();
  }, [tabKey]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // A mouse wheel scrolls the strip sideways.
    const wheel = (e: WheelEvent) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { e.preventDefault(); el.scrollLeft += e.deltaY; } };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  return <aside ref={host} className={`workspace-pane${panel.open ? " is-open" : ""}${panel.maximized ? " maximized" : ""}${compact ? " compact" : ""}`} style={{ "--tools-pane-width": panel.maximized || compact ? "100%" : `${paneWidth}px` } as CSSProperties} aria-label="Tools pane" aria-hidden={!panel.open} inert={!panel.open}>
    {!panel.maximized && !compact && <div className="workspace-resize" role="separator" aria-label="Resize tools pane" aria-orientation="vertical" tabIndex={0} aria-valuenow={paneWidth} aria-valuemin={MIN_TOOL_WIDTH} aria-valuemax={maxWidth} onKeyDown={e=>{if(e.key==="ArrowLeft" || e.key==="ArrowRight"){e.preventDefault();ui.panel(chatId,{width:Math.min(maxWidth,Math.max(MIN_TOOL_WIDTH,paneWidth+(e.key==="ArrowLeft"?20:-20)))});}}} onPointerDown={e=>{
      e.preventDefault();resizeCleanup.current?.();const start=e.clientX,width=host.current?.getBoundingClientRect().width ?? paneWidth;
      const move=(event:PointerEvent)=>ui.panel(chatId,{width:Math.min(Math.max(MIN_TOOL_WIDTH,(host.current?.parentElement?.clientWidth ?? availableWidth)-MIN_CHAT_WIDTH),Math.max(MIN_TOOL_WIDTH,width+start-event.clientX))});
      const end=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",end);window.removeEventListener("pointercancel",end);resizeCleanup.current=null;};
      resizeCleanup.current=end;
      window.addEventListener("pointermove",move);window.addEventListener("pointerup",end);window.addEventListener("pointercancel",end);
    }} />}
    <div className="workspace-bar"><div ref={strip} className={`workspace-tabs${overflow.start ? " more-start" : ""}${overflow.end ? " more-end" : ""}`} role="tablist" aria-label="Open tools" onScroll={measureStrip}>{panel.tabs.map(id=><div key={id} className={`workspace-tab${panel.active===id?" selected":""}`}><button role="tab" aria-selected={panel.active===id} onClick={()=>ui.panel(chatId,{active:id})}>{id.startsWith("sim:") ? <SimulationTabLabel id={id.slice(4) as Id<"simulationCases">} /> : label(id)}</button><button aria-label={`Close ${label(id)}`} onClick={()=>ui.closeSurface(chatId,id)}>×</button></div>)}</div><button title="Open a tool" aria-label="Open a tool" onClick={()=>ui.panel(chatId,{active:null})}>＋</button><button className="workspace-expand" title={panel.maximized ? "Restore split view (Esc)" : "Expand tool to full workspace"} aria-label={panel.maximized ? "Restore split view" : "Expand tool to full workspace"} aria-pressed={panel.maximized} onClick={()=>ui.panel(chatId,{maximized:!panel.maximized})}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {panel.maximized ? <path d="M21 3l-7 7m0-6v6h6M3 21l7-7m-6 0h6v6" /> : <path d="M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7" />}
      </svg>
    </button></div>
    <div className="workspace-content">
      {panel.active === null && <div className="workspace-launcher"><span className="workspace-eyebrow">TOOLS</span><h2>Open a tool</h2><p>Keep your work beside the conversation.</p>{["General","Engineering"].map(group=><section key={group}><h3>{group}</h3>{tools.filter(t=>t.group===group).map(t=><button key={t.id} onClick={()=>activate(t.id)} title={t.detail}><span className="tool-icon">{t.icon}</span><span><b>{t.label}</b><small>{t.detail}</small></span><span className="tool-action">↗</span></button>)}</section>)}</div>}
      {panel.tabs.map(id=><div key={id} className="workspace-surface" hidden={panel.active!==id}><ToolBoundary>
        {id==="browser" ? <BrowserPane chatId={chatId} /> : id==="files" ? <ContextPane chatId={chatId} /> : id==="cad" ? <Suspense fallback={<div className="workspace-empty">Loading CAD Viewer…</div>}><CadPane chatId={chatId} /></Suspense> : id.startsWith("job:") ? <ComputeJob id={id.slice(4) as Id<"computeJobs">} chatId={chatId} login={login} /> : id.startsWith("sim:") ? <SimulationView key={id} id={id.slice(4) as Id<"simulationCases">} chatId={chatId} login={login} /> : null}
      </ToolBoundary></div>)}
    </div>
  </aside>;
}

class ToolBoundary extends Component<{children:ReactNode},{error:boolean}> {
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  render(){return this.state.error ? <div className="workspace-empty"><b>Could not load this tool</b><p>Check the connection and try again.</p><button className="btn" onClick={()=>this.setState({error:false})}>Retry</button></div> : this.props.children;}
}

function BrowserPane({chatId}:{chatId:Id<"chats">}) {
  const panel=useUi().panels[chatId];
  const saved=panel?.browserUrl ?? "",home=!saved||!!panel?.browserHome;
  const [address,setAddress]=useState(saved),[error,setError]=useState("");
  const status=useBrowserStatus(chatId);
  useEffect(()=>setAddress(home?"":saved),[saved,home]);
  function navigate(){try{rememberBrowserUrl(chatId,normalizePreviewUrl(address));setError("");}catch{setError("Enter a valid HTTP or HTTPS URL without credentials");}}
  return <div className="workspace-browser"><form onSubmit={e=>{e.preventDefault();navigate();}}>
    <button type="button" aria-label="Browser start page" title="Recently used and local servers" onClick={()=>ui.panel(chatId,{browserHome:true})}>⌂</button>
    {bridge()?.browserPreview && <><button type="button" aria-label="Back" disabled={!status.back} onClick={()=>browserAction(chatId,"back")}>←</button><button type="button" aria-label="Forward" disabled={!status.forward} onClick={()=>browserAction(chatId,"forward")}>→</button><button type="button" aria-label={status.loading?"Stop loading":"Reload page"} onClick={()=>browserAction(chatId,status.loading?"stop":"reload")}>{status.loading?"×":"↻"}</button></>}
    <input aria-label="Web address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="Enter URL" /><button aria-label="Go" title="Go" type="submit">↵</button>{saved && <button type="button" title="Open in your browser" onClick={()=>{const b=bridge();if(b)b.openExternal(saved);else window.open(saved,"_blank","noopener");}}>↗</button>}</form>
    {(error||status.error)&&<p role="alert" className="compute-error">{error||status.error}</p>}{!home ? <>{!bridge()?.browserPreview&&<p className="compute-help">Some sites block embedded previews. Use ↗ to open them in your browser.</p>}<div className="browser-surface" data-browser-surface={chatId} /></> : <BrowserStart chat={chatId} onOpen={url=>{try{rememberBrowserUrl(chatId,normalizePreviewUrl(url));}catch{setError("Invalid URL");}}} />}</div>;

}

