import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ui, useUi } from "../lib/ui";
import { useFileDrop } from "../lib/fileDrop";
import { useAttachments } from "../components/Files";
import { CadViewer } from "./CadViewer";
import { CAD_ACCEPT, cadFormat, checkCadFile, type CadModel, type CadReference } from "./model";
import { fetchCad, importCad } from "./load";
import "./cad.css";

type ModelSource = { name: string; bytes: ArrayBuffer };
type LibraryItem = { key: string; name: string; reference: CadReference };
type Props = {
  reference: CadReference | null; resolve: (reference: CadReference, signal: AbortSignal) => Promise<ModelSource>;
  choose: (reference: CadReference | null) => void; items: LibraryItem[] | undefined;
  scope: "chat" | "workspace"; setScope: (scope: "chat" | "workspace") => void;
  attach: (files: File[]) => Promise<void>; uploading: boolean;
};

export default function CadPane({ chatId }: { chatId: Id<"chats"> }) {
  const convex = useConvex(), reference = useUi().panels[chatId]?.cadReference ?? null;
  const [scope, setScope] = useState<"chat" | "workspace">("chat");
  const rows = useQuery(api.files.context, { chatId, scope });
  const attachment = useAttachments(chatId);
  const resolve = useCallback(async (ref: CadReference, signal: AbortSignal): Promise<ModelSource> => {
    let file: { name: string; url: string | null } | null | undefined;
    if (ref.kind === "file") file = await convex.query(api.files.preview, { id: ref.id as Id<"files"> });
    else if (ref.kind === "source") file = (await convex.query(api.files.sourcePreview, { chatId, id: ref.id as Id<"contextSources"> })).file;
    else {
      const job = await convex.query(api.compute.get, { id: ref.jobId as Id<"computeJobs"> });
      if (job?.chatId !== chatId) throw new Error("This result belongs to another chat.");
      const output = job.outputs.find(o => o.id === ref.assetId);
      if (output) file = { name: output.path.split("/").at(-1)!, url: output.url };
    }
    signal.throwIfAborted();
    if (!file?.url) throw new Error("This model is no longer available. Choose another file from Context.");
    return { name: file.name, bytes: await fetchCad(file.url, signal) };
  }, [convex, chatId]);
  const items = rows?.filter(r => r.kind === "file" && cadFormat(r.title)).map(r => ({ key: r.key, name: r.title, reference: r.sourceId ? { kind: "source" as const, id: r.sourceId } : { kind: "file" as const, id: r.fileId! } }));
  return <CadWorkspace reference={reference} resolve={resolve} choose={ref => { ui.panel(chatId, { cadReference: ref }); }} items={items} scope={scope} setScope={setScope} attach={attachment.add} uploading={attachment.busy} />;
}

/** Presentation + local import lifecycle; no dependency on a runner or CAD session. */
export function CadWorkspace({ reference, resolve, choose, items, scope, setScope, attach, uploading }: Props) {
  const [model, setModel] = useState<CadModel | null>(null), [name, setName] = useState(""), [error, setError] = useState(""), [status, setStatus] = useState("");
  const [local, setLocal] = useState<File | null>(null), [library, setLibrary] = useState(false), [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null);
  const referenceKey = JSON.stringify(reference);
  async function load(read: (signal: AbortSignal) => Promise<ModelSource>, file: File | null = null, sample = false) {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setError(""); setStatus("Reading model…"); setModel(null); setName(file?.name ?? ""); setLocal(file); setLibrary(false);
    try {
      const data = await read(controller.signal); controller.signal.throwIfAborted(); setName(data.name); setStatus("Preparing 3D preview…");
      const result = await importCad(data.name, data.bytes, controller.signal, sample);
      if (!controller.signal.aborted) { setModel(result); setStatus(""); }
    } catch (e) { if (!controller.signal.aborted) { setStatus(""); setError(e instanceof Error ? e.message : "Could not open this model."); } }
  }
  useEffect(() => {
    const ref = JSON.parse(referenceKey) as CadReference | null;
    if (ref) void load(signal => resolve(ref, signal));
    // A null reference denotes a local file; changing to it must not cancel that import.
  }, [referenceKey, resolve]);
  useEffect(() => () => { pending.current?.abort(); }, []);
  function openFiles(files: File[]) {
    if (files.length !== 1) { setError("Open one model at a time."); return; }
    const file = files[0]!;
    try { checkCadFile(file.name, file.size); } catch (e) { setError((e as Error).message); return; }
    choose(null); void load(async () => ({ name: file.name, bytes: await file.arrayBuffer() }), file);
  }
  function cancel() { pending.current?.abort(); pending.current = null; setStatus(""); setName(""); setLocal(null); choose(null); }
  const drop = useFileDrop(openFiles);
  const shown = items?.filter(item => item.name.toLowerCase().includes(search.toLowerCase()));
  return <div className={`cad-workspace${drop.dragging ? " dragging" : ""}`} {...drop.handlers}>
    <header className="cad-bar">
      <span className="cad-title" title={name || undefined}>{name || "No model"}</span>
      <span className="cad-sep" />
      <span className="cad-src">{model ? `${model.format} · ${model.unit === "mm" ? "mm" : "model units"} · ${local ? "local" : reference ? "from context" : "sample"}` : status ? "opening…" : "drop a file, or open one"}</span>
      <span className="sp" />
      <button className="cad-k" onClick={() => { choose(null); void load(async () => ({ name: "Flanged reducer", bytes: new ArrayBuffer(0) }), null, true); }}>sample</button>
      <button className="cad-k" onClick={() => setLibrary(!library)} aria-expanded={library}>context</button>
      <button className="btn" onClick={() => input.current?.click()}>Open</button>
    </header>
    <input ref={input} type="file" accept={CAD_ACCEPT} hidden onChange={e => { if (e.target.files?.length) openFiles(Array.from(e.target.files)); e.target.value = ""; }} />
    {library && <section className="cad-library" aria-label="Models in Context"><div className="context-scopes" role="group" aria-label="Model source scope"><button aria-pressed={scope === "chat"} onClick={() => setScope("chat")}>This chat</button><button aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>Workspace</button></div><input className="workspace-search" placeholder="Find a model…" aria-label="Find a model" value={search} onChange={e => setSearch(e.target.value)} /><div className="cad-library-list">{shown?.map(item => <button key={item.key} onClick={() => { setLibrary(false); if (JSON.stringify(item.reference) === referenceKey) void load(signal => resolve(item.reference, signal)); else choose(item.reference); }}><span className="sq" aria-hidden="true" /><b>{item.name}</b><span>open ↗</span></button>)}{shown?.length === 0 && <p>No STEP, IGES, STL, or OBJ models in {scope === "chat" ? "this chat" : "workspace sources"}.</p>}{!shown && <p>Loading models…</p>}</div><small>Viewing a workspace model doesn’t add it to this chat’s context.</small></section>}
    {error && <div className="cad-error" role="alert"><span>{error}</span><button aria-label="Dismiss model error" onClick={() => setError("")}>×</button></div>}
    <div className="cad-viewport-wrap">
      <CadViewer model={model} name={name} />
      {status && <div className="cad-import-status" role="status"><b>{status}</b><span>{name || "Loading the original file"}</span><button className="btn ghost" onClick={cancel}>Cancel</button></div>}
    </div>
    {model && local && <div className="cad-local-note"><span>local preview · only on this device</span><button className="cad-k" disabled={uploading} onClick={() => void attach([local])}>{uploading ? "attaching…" : "attach to chat"}</button></div>}
    {drop.dragging && <div className="cad-drop-overlay"><span>Drop to open</span></div>}
  </div>;
}
