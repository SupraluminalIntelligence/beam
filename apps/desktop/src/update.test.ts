import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], children: [] as any[] }));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), { isPackaged: true, whenReady: () => Promise.resolve(), getPath: () => "/tmp", quit: vi.fn() }),
  BrowserWindow: class extends EventEmitter {
    static getAllWindows() { return host.windows; }
    webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
    hide = vi.fn();
    loadFile = vi.fn();
    constructor() { super(); host.windows.push(this); }
  },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => host.handlers.set(name, handler) },
  dialog: {}, shell: {}, Notification: {}, clipboard: {},
}));
vi.mock("electron-updater", () => ({ autoUpdater: Object.assign(new EventEmitter(), { quitAndInstall: vi.fn(), checkForUpdates: vi.fn(async () => null), downloadUpdate: vi.fn(async () => []) }) }));
vi.mock("node:child_process", () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
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
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  app.removeAllListeners(); autoUpdater.removeAllListeners();
  vi.mocked(autoUpdater.quitAndInstall).mockReset();
  host.handlers.clear(); host.windows.length = 0; host.children.length = 0;
  await import("./main");
  await Promise.resolve(); await Promise.resolve();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("keeps ordinary window close in the background but permits a normal quit", () => {
  expect(close().preventDefault).toHaveBeenCalledOnce();
  expect(host.windows[0].hide).toHaveBeenCalledOnce();
  expect(host.children[0].kill).not.toHaveBeenCalled();
  app.emit("before-quit");
  expect(close().preventDefault).not.toHaveBeenCalled();
  expect(host.children[0].kill).toHaveBeenCalledWith("SIGTERM");
});

it("allows the updater to close the window BEFORE before-quit and ignores repeated clicks", () => {
  autoUpdater.emit("update-downloaded", downloaded);
  vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
    expect(close().preventDefault).not.toHaveBeenCalled();
    expect(host.children[0].kill).not.toHaveBeenCalled();
    app.emit("before-quit");
  });
  install(); install();
  expect(status().state).toBe("installing");
  vi.advanceTimersByTime(0);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  expect(host.windows[0].hide).not.toHaveBeenCalled();
  expect(host.children[0].kill).toHaveBeenCalledWith("SIGTERM");
});

it.each(["throw", "event"])("restores normal close and leaves the runner alive on updater failure (%s)", (failure) => {
  autoUpdater.emit("update-downloaded", downloaded);
  vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
    if (failure === "throw") throw new Error("Install failed");
  });
  install(); vi.advanceTimersByTime(0);
  if (failure === "event") autoUpdater.emit("error", new Error("Install failed"));
  expect(status()).toMatchObject({ state: "error", message: "Install failed" });
  expect(close().preventDefault).toHaveBeenCalledOnce();
  expect(host.children[0].kill).not.toHaveBeenCalled();
});

it("does not try to install an update before it is ready", () => {
  install(); vi.advanceTimersByTime(0);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(close().preventDefault).toHaveBeenCalledOnce();
});
