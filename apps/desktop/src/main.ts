import { openTerminal, psQuote } from "./terminal";
import { showNotification } from "./notifications";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Notification, clipboard } from "electron";
import { installPreviewHost } from "./preview";
import { autoUpdater } from "electron-updater";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { ignoreBrokenPipeErrors } from "./stdio";

ignoreBrokenPipeErrors(process.stdout, process.stderr);

/**
 * Beam desktop shell. Owns a window that shows apps/web and a runner child process.
 * The runner is a standalone program (apps/runner) with its own identity; we launch it with --app
 * so its pairing code comes to us on stdout and the signed-in renderer approves it without a click.
 */
let runner: ChildProcess | null = null;
if (process.platform === "win32") app.setAppUserModelId("ai.supraluminal.beam");

/**
 * Development only: several checkouts can run side by side (see CONTRIBUTING.md, "Several checkouts at once").
 * BEAM_WEB_PORT picks which dev server this window loads, BEAM_NO_RUNNER leaves the runner to another instance
 * (the window borrows that runner's identity, see borrowRunner),
 * and a window with its own runner profile (BEAM_HOME) or its own port gets its own Electron profile. A window without
 * a runner ignores an inherited BEAM_HOME here, so runner-less windows on different ports never share storage.
 */
const devPort = Number(process.env["BEAM_WEB_PORT"] ?? 5173);
const noRunner = !app.isPackaged && process.env["BEAM_NO_RUNNER"] === "1";
if (!app.isPackaged) {
  const profile = process.env["BEAM_HOME"] && !noRunner ? join(process.env["BEAM_HOME"], "electron") : devPort !== 5173 ? `${app.getPath("userData")}-${devPort}` : null;
  if (profile) app.setPath("userData", profile);
}

/**
 * Updates: electron-updater against the public releases repo (SupraluminalIntelligence/beam-releases). The renderer shows a
 * pill when a version is available; downloading and installing are the person's clicks, never automatic.
 */
type UpdateState = { state: "none" | "checking" | "available" | "downloading" | "ready" | "installing" | "error"; version: string | null; percent: number; message: string | null };
let update: UpdateState = { state: "none", version: null, percent: 0, message: null };
function setUpdate(next: Partial<UpdateState>) { update = { ...update, ...next }; win?.webContents.send("beam:update", update); }
function updateFailed(error: Error) {
  if (update.state === "installing") {
    quitting = false;
    if (!runner) startRunner();
  }
  setUpdate({ state: update.version ? "error" : "none", message: error.message.slice(0, 200) });
}
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => setUpdate({ state: update.state === "none" ? "checking" : update.state, message: null }));
  const busy = () => ["downloading", "ready", "installing"].includes(update.state);
  autoUpdater.on("update-available", (info) => { if (!busy()) setUpdate({ state: "available", version: info.version, percent: 0 }); });
  autoUpdater.on("update-not-available", () => { if (!busy()) setUpdate({ state: "none", version: null }); });
  autoUpdater.on("download-progress", (p) => setUpdate({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => setUpdate({ state: "ready", version: info.version, percent: 100 }));
  autoUpdater.on("error", updateFailed);
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
let win: BrowserWindow | null = null;
let quitting = false;
let pendingPair: string | null = null;
let localRunnerId: string | null = null;
const runnerLog: string[] = [];
if (noRunner) runnerLog.push("BEAM_NO_RUNNER=1: this window starts no runner; runs go to your other runner");
/**
 * A window without a runner reports the one paired in this Mac's profile (usually Beam's) as its own, so "My default"
 * still means this Mac. Only the id is borrowed; whether that runner is online is the server's call.
 */
let borrowed: { runnerId: string; convexUrl: string } | null = null;
let borrowRetry: ReturnType<typeof setTimeout> | null = null;
function borrowRunner() {
  if (borrowed || borrowRetry || quitting) return;
  const entry = join(__dirname, "..", "..", "runner", "src", "cli.ts");
  execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, "whoami"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000, maxBuffer: 65536 }, (error, stdout) => {
    try { borrowed = error ? null : JSON.parse(stdout); } catch { borrowed = null; }
    // Not paired yet, or offline: look again later.
    if (!borrowed) borrowRetry = setTimeout(() => { borrowRetry = null; borrowRunner(); }, 30_000);
  });
}
// The runner is this Mac's connection to Beam. If it dies on its own, bring it back, backing off while it keeps dying.
let runnerStopping: ChildProcess | null = null;
let runnerFailures = 0;
let runnerRetry: ReturnType<typeof setTimeout> | null = null;

function startRunner() {
  if (quitting) return;
  if (noRunner) { borrowRunner(); return; }
  if (runnerRetry) { clearTimeout(runnerRetry); runnerRetry = null; }
  localRunnerId = null;
  const startedAt = Date.now();
  // Packaged: the esbuild bundle next to main.cjs, kept outside app.asar so the runtime can read it as a file.
  // Dev: the runner's TypeScript source, run with strip-types.
  const packaged = app.isPackaged;
  const entry = packaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  const child = runner = spawn(process.execPath, packaged ? [entry, "start", "--app"] : ["--experimental-strip-types", "--no-warnings", entry, "start", "--app"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    cwd: packaged ? app.getPath("home") : join(__dirname, "..", "..", ".."),
  });
  const push = (s: string) => { runnerLog.push(s); if (runnerLog.length > 200) runnerLog.shift(); win?.webContents.send("beam:runnerLog", s); if (process.env["BEAM_DEV"]) console.log(`[runner] ${s}`); };
  createInterface({ input: runner.stdout! }).on("line", (l) => {
    const identity = l.match(/^BEAM_RUNNER ([a-zA-Z0-9_-]+)$/);
    if (identity) { if (runner === child) localRunnerId = identity[1]!; return; }
    push(l);
    const m = l.match(/^BEAM_PAIR ([A-Z0-9-]+)$/);
    if (m) { pendingPair = m[1]!; win?.webContents.send("beam:pair", pendingPair); }
    if (/^Signed in as/.test(l)) pendingPair = null;
  });
  createInterface({ input: runner.stderr! }).on("line", (l) => push(`! ${l}`));
  runner.on("exit", (code, signal) => {
    push(`runner exited (${code ?? signal})`);
    if (runner !== child) return;
    runner = null; localRunnerId = null;
    if (quitting || runnerStopping === child) return;
    runnerFailures = Date.now() - startedAt > 60_000 ? 1 : runnerFailures + 1;
    const delay = Math.min(30_000, 1_000 * 2 ** (runnerFailures - 1));
    push(`restarting runner in ${Math.round(delay / 1000)}s`);
    runnerRetry = setTimeout(startRunner, delay);
  });
}

/**
 * On SIGTERM the runner interrupts its runs and waits for them to land (commit, push, report) for up to 45s, then takes
 * up to 5s to go offline. Give it that and a margin before killing it: a run always ends with a push.
 */
const RUNNER_GRACE_MS = 60_000;
let runnerExit: Promise<void> | null = null;
/** Stop the runner without restarting it, and resolve once it has exited. */
function stopRunner(): Promise<void> {
  const child = runner;
  if (!child) return Promise.resolve();
  if (runnerStopping === child && runnerExit) return runnerExit;
  runnerStopping = child;
  runnerExit = new Promise<void>((resolve) => {
    const kill = setTimeout(() => { child.kill("SIGKILL"); }, RUNNER_GRACE_MS);
    child.once("exit", () => { clearTimeout(kill); resolve(); });
  });
  // Windows kill(SIGTERM) terminates immediately. IPC lets the runner land its work first.
  if (child.connected) child.send({ type: "beam:shutdown" }, () => {});
  else if (process.platform !== "win32") child.kill("SIGTERM");
  return runnerExit;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 900, minHeight: 600,
    ...(process.platform === "win32" ? { icon: join(__dirname, "icon.png") } : {}),
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: "#0F1214",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, webviewTag: true, backgroundThrottling: false },
  });
  installPreviewHost(win.webContents);
  if (process.env["BEAM_DEV"]) { win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2 || /convex|auth|beam/i.test(msg)) console.log(`[renderer] ${msg}`); }); }
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[renderer] failed to load ${url}: ${code} ${desc}`));
  if (process.env["BEAM_DEV"]) void win.loadURL(`http://localhost:${devPort}`);
  else void win.loadFile(join(__dirname, "web", "index.html"));
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      if (process.platform === "darwin") win?.hide();
      else app.quit();
    }
  });
  win.on("closed", () => { win = null; });
}

ipcMain.handle("beam:openTerminalWith", async (event, command: string) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  if (typeof command !== "string" || command.length > 8192) throw new Error("Invalid command");
  await openTerminal(command);
});

ipcMain.handle("beam:signInConnection", async (event, value: { harness: string; id: string }) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  if (!["codex", "claude"].includes(value?.harness) || !/^(default|[0-9a-f-]{36})$/.test(value.id)) throw new Error("Invalid profile");
  const entry = app.isPackaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  // Separate validated values survive Windows PowerShell's legacy native argument quoting.
  const args = [process.execPath, ...(app.isPackaged ? [] : ["--experimental-strip-types", "--no-warnings"]), entry, "connection-login", value.harness, value.id];
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const command = process.platform === "win32"
    ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${args.map(psQuote).join(" ")}`
    : `ELECTRON_RUN_AS_NODE=1 ${args.map(quote).join(" ")}`;
  await openTerminal(command);
});

const previewChildren = new Set<ChildProcess>();
ipcMain.handle("beam:resourcePreview", (event, value: { chatId: string; resourceId: string }) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  if (!/^[a-zA-Z0-9_-]+$/.test(value?.chatId) || !/^[a-zA-Z0-9_-]+$/.test(value?.resourceId)) throw new Error("Invalid resource");
  const entry = app.isPackaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  const args = [...(app.isPackaged ? [] : ["--experimental-strip-types", "--no-warnings"]), entry, "resource-preview", JSON.stringify(value)];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"] });
    previewChildren.add(child);
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Preview host did not start")); }, 15000);
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => { if (/^BEAM_PREVIEW http:\/\/127\.0\.0\.1:\d+\/\?beam_preview=[a-f0-9]+$/.test(line)) { clearTimeout(timeout); resolve(line.slice(13)); lines.close(); } });
    child.on("error", () => { clearTimeout(timeout); previewChildren.delete(child); reject(new Error("Could not start preview")); });
    child.on("exit", () => { clearTimeout(timeout); previewChildren.delete(child); reject(new Error("Preview closed")); });
  });
});
app.on("before-quit", () => { for (const child of previewChildren) child.kill(); });

ipcMain.handle("beam:shareResource", (event, value: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  const payload = JSON.stringify(value); if (!payload || payload.length > 8192) throw new Error("Invalid resource");
  const entry = app.isPackaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  const args = app.isPackaged ? [entry, "share-resource", payload] : ["--experimental-strip-types", "--no-warnings", entry, "share-resource", payload];
  return new Promise((resolve, reject) => execFile(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, maxBuffer: 65536 }, (error, stdout) => {
    if (error) { reject(new Error("Could not share this resource. Check that your runner is online and the folder exists.")); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid resource response")); }
  }));
});

let profileMutation: Promise<unknown> = Promise.resolve();
ipcMain.handle("beam:connections", (event, value: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid sender");
  const payload = JSON.stringify(value);
  if (!payload || payload.length > 8192) throw new Error("Invalid connection request");
  const entry = app.isPackaged ? join(__dirname.replace("app.asar", "app.asar.unpacked"), "runner.mjs") : join(__dirname, "..", "..", "runner", "src", "cli.ts");
  const args = app.isPackaged ? [entry, "connections", payload] : ["--experimental-strip-types", "--no-warnings", entry, "connections", payload];
  const run = () => new Promise((resolve, reject) => execFile(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000, maxBuffer: 65536 }, (error, stdout) => {
    if (error) { reject(new Error("Could not update connection profiles. Check the directory and profile name.")); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid connection response")); }
  }));
  const result = profileMutation.then(run, run); profileMutation = result.catch(() => {}); return result;
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
ipcMain.handle("beam:update:install", () => {
  if (update.state !== "ready") return;
  setUpdate({ state: "installing", message: null });
  // Land the runner's runs first: once Squirrel starts quitting, before-quit is too late to wait for them.
  void stopRunner().then(() => setImmediate(() => {
    // Squirrel closes windows BEFORE app.before-quit. Allow that close instead of
    // hiding the window and cancelling the update.
    quitting = true;
    try { autoUpdater.quitAndInstall(process.platform === "win32", true); }
    catch (error) { updateFailed(error instanceof Error ? error : new Error(String(error))); }
  }));
});
ipcMain.handle("beam:openExternal", (_e, url: string) => { if (process.env["BEAM_TEST"]) { console.log(`BEAM_OPEN ${url}`); return; } return shell.openExternal(url); });
ipcMain.handle("beam:runnerStatus", () => ({ runnerId: localRunnerId ?? borrowed?.runnerId ?? null, running: !!runner || !!borrowed, pid: runner?.pid ?? null, pendingPair, log: runnerLog.slice(-40), borrowed: noRunner, convexUrl: borrowed?.convexUrl ?? null }));
ipcMain.handle("beam:restartRunner", () => { runnerFailures = 0; void stopRunner().then(() => setTimeout(startRunner, 500)); });

/**
 * Electron's default macOS menu labels its app items with the package name ("Quit @beam/desktop"). Same menu, named Beam.
 * Renaming the app itself (app.setName) would also move its profile and keychain entry, signing everyone out.
 */
function setupMenu() {
  if (process.platform !== "darwin") return;
  // The About panel reads the package name otherwise; renaming the app itself would move its data (see above).
  app.setAboutPanelOptions({ applicationName: "Beam" });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Beam", submenu: [
      { role: "about", label: "About Beam" }, { type: "separator" }, { role: "services" }, { type: "separator" },
      { role: "hide", label: "Hide Beam" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "Quit Beam" },
    ] },
    { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
}

app.whenReady().then(() => { setupMenu(); setupUpdates(); }).then(() => { startRunner(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  quitting = true;
  if (runnerRetry) { clearTimeout(runnerRetry); runnerRetry = null; }
  if (!runner) return;
  // Quit once the runner has landed its runs; its exit clears `runner`, so the second quit goes through.
  event.preventDefault();
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  void stopRunner().then(() => app.quit());
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); win?.show(); win?.focus(); });

// Renderer is authenticated with Convex; only our own main frame may request a native banner.
ipcMain.handle("beam:notify", (event, value: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || !Notification.isSupported()) return false;
  const n = value as { id?: unknown; title?: unknown; body?: unknown; silent?: unknown; workspaceId?: unknown; chatId?: unknown; messageId?: unknown } | null;
  if (!n || typeof n.id !== "string" || typeof n.title !== "string" || typeof n.body !== "string" || n.id.length > 200 || n.title.length > 200 || n.body.length > 500) return false;
  const target = {
    id: n.id, title: n.title, body: n.body, silent: n.silent === true,
    ...(typeof n.workspaceId === "string" ? { workspaceId: n.workspaceId } : {}),
    ...(typeof n.chatId === "string" ? { chatId: n.chatId } : {}),
    ...(typeof n.messageId === "string" ? { messageId: n.messageId } : {}),
  };
  return showNotification(target, () => {
    win?.show(); if (win?.isMinimized()) win.restore(); win?.focus();
    if (target.workspaceId && target.chatId) win?.webContents.send("beam:notificationClick", target);
  });
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
