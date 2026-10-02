import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], children: [] as any[] }));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), { isPackaged: true, whenReady: () => Promise.resolve(), getPath: () => "/tmp", quit: vi.fn(), setAppUserModelId: vi.fn(), setAboutPanelOptions: vi.fn() }),
  BrowserWindow: class extends EventEmitter {
    static getAllWindows() { return host.windows; }
    webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
    hide = vi.fn();
    loadFile = vi.fn();
    constructor(readonly options: any) { super(); host.windows.push(this); }
  },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => host.handlers.set(name, handler) },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
  dialog: {}, shell: {}, Notification: {}, clipboard: {},
}));
vi.mock("electron-updater", () => ({ autoUpdater: Object.assign(new EventEmitter(), { quitAndInstall: vi.fn(), checkForUpdates: vi.fn(async () => null), downloadUpdate: vi.fn(async () => []) }) }));
vi.mock("node:child_process", () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), connected: true, send: vi.fn(), kill: vi.fn() });
  host.children.push(child); return child;
}, spawnSync: vi.fn(), execFile: vi.fn() }));
vi.mock("./preview", () => ({ installPreviewHost: vi.fn() }));
vi.mock("./notifications", () => ({ showNotification: vi.fn() }));
import { app } from "electron";
import { autoUpdater } from "electron-updater";

const downloaded = { version: "0.1.6", downloadedFile: "/tmp/Beam.zip", files: [], path: "Beam.zip", sha512: "test", releaseDate: "2026-09-23T00:00:00.000Z" };
const status = () => host.handlers.get("beam:update:status")!();
const install = () => host.handlers.get("beam:update:install")!();
const close = () => {
  const event = { preventDefault: vi.fn() };
  host.windows[0].emit("close", event);
  return event;
};
let outputListeners: Map<NodeJS.WriteStream, ReturnType<NodeJS.WriteStream["listeners"]>>;
beforeEach(async () => {
  outputListeners = new Map([process.stdout, process.stderr].map(stream => [stream, stream.listeners("error")]));
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  app.removeAllListeners(); autoUpdater.removeAllListeners();
  vi.mocked(autoUpdater.quitAndInstall).mockReset();
  host.handlers.clear(); host.windows.length = 0; host.children.length = 0;
  await import("./main");
  await Promise.resolve(); await Promise.resolve();
});
afterEach(() => {
  for (const [stream, listeners] of outputListeners) {
    for (const listener of stream.listeners("error")) if (!listeners.includes(listener)) stream.off("error", listener as (error: Error) => void);
  }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("still delivers runner logs after desktop output reports a broken pipe", () => {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  expect(() => process.stdout.emit("error", error)).not.toThrow();
  expect(() => process.stderr.emit("error", error)).not.toThrow();
  host.children[0].stdout.write("runner remains online\n");
  expect(host.windows[0].webContents.send).toHaveBeenCalledWith("beam:runnerLog", "runner remains online");
  expect(host.handlers.get("beam:runnerStatus")!()).toMatchObject({ running: true, log: ["runner remains online"] });
});

/** The runner has landed its runs and exits. */
const runnerExits = (i = 0) => host.children[i].emit("exit", 0, "SIGTERM");

it("keeps ordinary window close in the background, and quits once the runner has landed its runs", async () => {
  expect(close().preventDefault).toHaveBeenCalledOnce();
  expect(host.windows[0].hide).toHaveBeenCalledOnce();
  expect(host.children[0].kill).not.toHaveBeenCalled();
  const quit = { preventDefault: vi.fn() };
  app.emit("before-quit", quit);
  expect(quit.preventDefault).toHaveBeenCalledOnce();
  expect(host.windows[0].hide).toHaveBeenCalledTimes(2);
  expect(host.children[0].send).toHaveBeenCalledWith({ type: "beam:shutdown" }, expect.any(Function));
  expect(app.quit).not.toHaveBeenCalled();
  runnerExits(); await vi.advanceTimersByTimeAsync(0);
  expect(app.quit).toHaveBeenCalledOnce();
  const again = { preventDefault: vi.fn() };
  app.emit("before-quit", again);
  expect(again.preventDefault).not.toHaveBeenCalled();
  expect(close().preventDefault).not.toHaveBeenCalled();
  expect(host.children).toHaveLength(1);
});

it("kills a runner that has not exited within the grace period, then quits", async () => {
  app.emit("before-quit", { preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(59_000);
  expect(host.children[0].kill).not.toHaveBeenCalledWith("SIGKILL");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(host.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  expect(app.quit).not.toHaveBeenCalled();
  host.children[0].emit("exit", null, "SIGKILL"); await vi.advanceTimersByTimeAsync(0);
  expect(app.quit).toHaveBeenCalledOnce();
});

it("stops the runner before the updater takes over, and ignores repeated clicks", async () => {
  autoUpdater.emit("update-downloaded", downloaded);
  vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
    expect(close().preventDefault).not.toHaveBeenCalled();
    const quit = { preventDefault: vi.fn() };
    app.emit("before-quit", quit);
    expect(quit.preventDefault).not.toHaveBeenCalled();
  });
  install(); install();
  expect(status().state).toBe("installing");
  expect(host.children[0].send).toHaveBeenCalledExactlyOnceWith({ type: "beam:shutdown" }, expect.any(Function));
  await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled(); // the runner is still landing
  expect(close().preventDefault).toHaveBeenCalledOnce();
  runnerExits(); await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  expect(host.windows[0].hide).toHaveBeenCalledOnce(); // only by the close above, never by the quit
  expect(host.children).toHaveLength(1);
});

it.each(["throw", "event"])("restores normal close and restarts the runner on updater failure (%s)", async (failure) => {
  autoUpdater.emit("update-downloaded", downloaded);
  vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
    if (failure === "throw") throw new Error("Install failed");
  });
  install(); runnerExits(); await vi.advanceTimersByTimeAsync(0);
  if (failure === "event") autoUpdater.emit("error", new Error("Install failed"));
  expect(status()).toMatchObject({ state: "error", message: "Install failed" });
  expect(close().preventDefault).toHaveBeenCalledOnce();
  expect(host.children).toHaveLength(2);
});

it("waits for the runner to exit before starting it again", async () => {
  host.handlers.get("beam:restartRunner")!();
  expect(host.children[0].send).toHaveBeenCalledWith({ type: "beam:shutdown" }, expect.any(Function));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(host.children).toHaveLength(1);
  runnerExits(); await vi.advanceTimersByTimeAsync(500);
  expect(host.children).toHaveLength(2);
});

it("does not try to install an update before it is ready", async () => {
  install(); await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(close().preventDefault).toHaveBeenCalledOnce();
});

it("suppresses a pending runner restart during installation and recovers it after failure", async () => {
  host.children[0].emit("exit", 1, null);
  autoUpdater.emit("update-downloaded", downloaded);
  install(); await vi.advanceTimersByTimeAsync(2000);
  expect(host.children).toHaveLength(1);
  autoUpdater.emit("error", new Error("Install failed"));
  expect(host.children).toHaveLength(2);
  expect(status().state).toBe("error");
});

it("uses native Windows controls and quits through graceful IPC when closed", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.resetModules();
  app.removeAllListeners(); autoUpdater.removeAllListeners();
  host.handlers.clear(); host.windows.length = 0; host.children.length = 0;
  await import("./main");
  await Promise.resolve(); await Promise.resolve();
  expect(host.windows[0].options.titleBarStyle).toBeUndefined();
  expect(app.setAppUserModelId).toHaveBeenCalledWith("ai.supraluminal.beam");
  expect(close().preventDefault).toHaveBeenCalledOnce();
  expect(app.quit).toHaveBeenCalledOnce();
  app.emit("before-quit", { preventDefault: vi.fn() });
  expect(host.children[0].send).toHaveBeenCalledWith({ type: "beam:shutdown" }, expect.any(Function));
  expect(host.children[0].kill).not.toHaveBeenCalled();
  runnerExits(); await vi.advanceTimersByTimeAsync(0);
  expect(app.quit).toHaveBeenCalledTimes(2);
});

it("installs Windows updates silently only after the runner exits, then reopens Beam", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  autoUpdater.emit("update-downloaded", downloaded);
  install();
  expect(host.children[0].send).toHaveBeenCalledWith({ type: "beam:shutdown" }, expect.any(Function));
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  runnerExits(); await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
});

it("does not discard a downloaded update when a background check finishes", () => {
  autoUpdater.emit("update-downloaded", downloaded);
  autoUpdater.emit("checking-for-update");
  autoUpdater.emit("update-available", downloaded);
  expect(status().state).toBe("ready");
  autoUpdater.emit("update-not-available", downloaded);
  expect(status().state).toBe("ready");
});
