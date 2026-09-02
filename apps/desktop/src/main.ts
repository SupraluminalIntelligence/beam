import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * Beam desktop shell. Owns two things: a window that shows apps/web, and a runner child process.
 * The runner is a standalone program (apps/runner); we merely launch it, the way T3 Code launches its server
 * via ELECTRON_RUN_AS_NODE. The renderer never talks to the runner directly; both talk to Convex.
 */
let runner: ChildProcess | null = null;

function startRunner() {
  const entry = join(__dirname, "..", "..", "runner", "src", "cli.ts");
  runner = spawn(process.execPath, ["--experimental-strip-types", entry, "start"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout?.on("data", (d) => process.stdout.write(`[runner] ${d}`));
  runner.stderr?.on("data", (d) => process.stderr.write(`[runner] ${d}`));
  runner.on("exit", (code) => { console.log(`[runner] exited ${code}`); runner = null; });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#0F1214",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  if (process.env["BEAM_DEV"]) void win.loadURL("http://localhost:5173");
  else void win.loadFile(join(__dirname, "..", "..", "web", "dist", "index.html"));
}

ipcMain.handle("beam:openTerminalWith", async (_e, command: string) => {
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
    spawn("osascript", ["-e", script]);
  } else {
    await shell.openExternal("about:blank"); // TODO: win32/linux terminal handoff
  }
});
ipcMain.handle("beam:pickFolder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle("beam:openExternal", (_e, url: string) => shell.openExternal(url));
ipcMain.handle("beam:runnerStatus", () => ({ running: !!runner, pid: runner?.pid ?? null }));

app.whenReady().then(() => { startRunner(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { runner?.kill(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
