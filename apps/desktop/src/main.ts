import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

/**
 * Beam desktop shell. Owns a window that shows apps/web and a runner child process.
 * The runner is a standalone program (apps/runner) with its own identity; we launch it with --app
 * so its pairing code comes to us on stdout and the signed-in renderer approves it without a click.
 */
let runner: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let pendingPair: string | null = null;
const runnerLog: string[] = [];

function startRunner() {
  const entry = join(__dirname, "..", "..", "runner", "src", "cli.ts");
  runner = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, "start", "--app"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(__dirname, "..", "..", ".."),
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
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  if (process.env["BEAM_DEV"]) void win.loadURL("http://localhost:5173");
  else void win.loadFile(join(__dirname, "..", "..", "web", "dist", "index.html"));
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
ipcMain.handle("beam:pickFolder", async () => { const r = await dialog.showOpenDialog({ properties: ["openDirectory"] }); return r.canceled ? null : (r.filePaths[0] ?? null); });
ipcMain.handle("beam:openExternal", (_e, url: string) => shell.openExternal(url));
ipcMain.handle("beam:runnerStatus", () => ({ running: !!runner, pid: runner?.pid ?? null, pendingPair, log: runnerLog.slice(-40) }));
ipcMain.handle("beam:restartRunner", () => { runner?.kill(); setTimeout(startRunner, 500); });

app.whenReady().then(() => { startRunner(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { runner?.kill("SIGTERM"); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
