import { app, BrowserWindow, dialog, ipcMain, shell, Notification, clipboard } from "electron";
import { installPreviewHost } from "./preview";
import { autoUpdater } from "electron-updater";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";

/**
 * Beam desktop shell. Owns a window that shows apps/web and a runner child process.
 * The runner is a standalone program (apps/runner) with its own identity; we launch it with --app
 * so its pairing code comes to us on stdout and the signed-in renderer approves it without a click.
 */
let runner: ChildProcess | null = null;

/**
 * Updates: electron-updater against the public releases repo (SupraluminalAI/beam-releases). The renderer shows a
 * pill when a version is available; downloading and installing are the person's clicks, never automatic.
 */
type UpdateState = { state: "none" | "checking" | "available" | "downloading" | "ready" | "error"; version: string | null; percent: number; message: string | null };
let update: UpdateState = { state: "none", version: null, percent: 0, message: null };
function setUpdate(next: Partial<UpdateState>) { update = { ...update, ...next }; win?.webContents.send("beam:update", update); }
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => setUpdate({ state: update.state === "none" ? "checking" : update.state, message: null }));
  autoUpdater.on("update-available", (info) => setUpdate({ state: "available", version: info.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => setUpdate({ state: "none", version: null }));
  autoUpdater.on("download-progress", (p) => setUpdate({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => setUpdate({ state: "ready", version: info.version, percent: 100 }));
  autoUpdater.on("error", (e) => setUpdate({ state: update.version ? "error" : "none", message: e.message.slice(0, 200) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
let win: BrowserWindow | null = null;
let quitting = false;
const banners = new Map<string, Notification>();
let pendingPair: string | null = null;
const runnerLog: string[] = [];

function startRunner() {
  // Packaged: the esbuild bundle next to main.cjs, kept outside app.asar so the runtime can read it as a file.
  // Dev: the runner's TypeScript source, run with strip-types.
  const packaged = app.isPackaged;
  const entry = packaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  runner = spawn(process.execPath, packaged ? [entry, "start", "--app"] : ["--experimental-strip-types", "--no-warnings", entry, "start", "--app"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: packaged ? app.getPath("home") : join(__dirname, "..", "..", ".."),
  });
  const push = (s: string) => { runnerLog.push(s); if (runnerLog.length > 200) runnerLog.shift(); win?.webContents.send("beam:runnerLog", s); };
  createInterface({ input: runner.stdout! }).on("line", (l) => {
    push(l);
    const m = l.match(/^BEAM_PAIR ([A-Z0-9-]+)$/);
    if (m) { pendingPair = m[1]!; win?.webContents.send("beam:pair", pendingPair); }
    if (/^Signed in as/.test(l)) pendingPair = null;
  });
  createInterface({ input: runner.stderr! }).on("line", (l) => push(`! ${l}`));
  runner.on("exit", (code) => { push(`runner exited (${code})`); runner = null; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#0F1214",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, webviewTag: true, backgroundThrottling: false },
  });
  installPreviewHost(win.webContents);
  if (process.env["BEAM_DEV"]) { win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2 || /convex|auth|beam/i.test(msg)) console.log(`[renderer] ${msg}`); }); }
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[renderer] failed to load ${url}: ${code} ${desc}`));
  if (process.env["BEAM_DEV"]) void win.loadURL("http://localhost:5173");
  else void win.loadFile(join(__dirname, "web", "index.html"));
  win.on("close", (event) => { if (!quitting) { event.preventDefault(); win?.hide(); } });
  win.on("closed", () => { win = null; });
}

ipcMain.handle("beam:openTerminalWith", async (_e, command: string) => {
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
    spawn("osascript", ["-e", script]);
  } else {
    await shell.openExternal("about:blank"); // TODO: win32/linux terminal handoff
  }
});
let serverScan: Promise<unknown> | null = null;
let serverScanAt = 0;
ipcMain.handle("beam:localServers", event => {
  if(event.sender!==win?.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error("Invalid sender");
  if(!serverScan || Date.now()-serverScanAt>15_000) {
    serverScanAt=Date.now();
    const entry=app.isPackaged?join(__dirname.replace("app.asar","app.asar.unpacked"),"runner.mjs"):join(__dirname,"..","..","runner","src","cli.ts");
    const args=app.isPackaged?[entry,"local-servers"]:["--experimental-strip-types","--no-warnings",entry,"local-servers"];
    serverScan=new Promise((resolve,reject)=>execFile(process.execPath,args,{env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},timeout:20_000,maxBuffer:1024*1024},(error,stdout)=>{if(error){reject(new Error("Could not discover local servers"));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error("Invalid discovery response"));}}));
  }
  return serverScan;
});
ipcMain.handle("beam:pickFolder", async () => { const r = await dialog.showOpenDialog({ properties: ["openDirectory"] }); return r.canceled ? null : (r.filePaths[0] ?? null); });
ipcMain.handle("beam:version", () => app.getVersion());
ipcMain.handle("beam:update:status", () => update);
ipcMain.handle("beam:update:check", () => { if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => {}); return update; });
ipcMain.handle("beam:update:download", () => { if (update.state === "available" || update.state === "error") { setUpdate({ state: "downloading", percent: 0, message: null }); void autoUpdater.downloadUpdate().catch((e) => setUpdate({ state: "error", message: (e as Error).message.slice(0, 200) })); } });
ipcMain.handle("beam:update:install", () => { if (update.state === "ready") { try { runner?.kill("SIGTERM"); } catch {} setImmediate(() => autoUpdater.quitAndInstall(false, true)); } });
ipcMain.handle("beam:openExternal", (_e, url: string) => { if (process.env["BEAM_TEST"]) { console.log(`BEAM_OPEN ${url}`); return; } return shell.openExternal(url); });
ipcMain.handle("beam:runnerStatus", () => ({ running: !!runner, pid: runner?.pid ?? null, pendingPair, log: runnerLog.slice(-40) }));
ipcMain.handle("beam:restartRunner", () => { runner?.kill(); setTimeout(startRunner, 500); });

app.whenReady().then(() => { setupUpdates(); }).then(() => { startRunner(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { quitting = true; runner?.kill("SIGTERM"); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); win?.show(); win?.focus(); });

// Renderer is authenticated with Convex; only our own main frame may request a native banner.
ipcMain.handle("beam:notify", (event, value: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || !Notification.isSupported()) return false;
  const n = value as { id?: unknown; title?: unknown; body?: unknown; silent?: unknown; workspaceId?: unknown; chatId?: unknown } | null;
  if (!n || typeof n.id !== "string" || typeof n.title !== "string" || typeof n.body !== "string" || n.id.length > 200 || n.title.length > 200 || n.body.length > 500) return false;
  if (banners.has(n.id)) return true;
  const banner = new Notification({ title: n.title, body: n.body, silent: n.silent === true });
  const id = n.id;
  banners.set(id, banner);
  banner.on("click", () => {
    win?.show(); if (win?.isMinimized()) win.restore(); win?.focus();
    if (typeof n.workspaceId === "string" && typeof n.chatId === "string") win?.webContents.send("beam:notificationClick", { id, workspaceId: n.workspaceId, chatId: n.chatId });
  });
  banner.on("close", () => banners.delete(id));
  banner.on("failed", () => banners.delete(id));
  banner.show();
  return true;
});

// Only files explicitly present in the native clipboard can be read by the renderer.
ipcMain.handle("beam:clipboardFiles", async event => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  let paths: string[] = [];
  const raw = clipboard.readBuffer("NSFilenamesPboardType");
  if (process.platform === "darwin" && raw.length) {
    const result = spawnSync("/usr/bin/plutil", ["-convert","json","-o","-","-"], {input:raw,maxBuffer:1024*1024});
    if (result.status === 0) { const values: unknown = JSON.parse(result.stdout.toString()); if (Array.isArray(values)) paths = values.filter((p): p is string=>typeof p === "string"); }
  }
  if (!paths.length) {
    const urls = clipboard.read("public.file-url") || clipboard.read("text/uri-list");
    paths = urls.split(/\r?\n/).filter(u=>u.startsWith("file://")).map(u=>fileURLToPath(u));
  }
  if (paths.length > 10) throw new Error("Paste up to 10 files at a time");
  const out: {name:string;base64:string}[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size > 20*1024*1024) throw new Error("Paste files of 20 MB or smaller; folders are not supported");
    out.push({name:basename(path),base64:(await readFile(path)).toString("base64")});
  }
  return out;
});
