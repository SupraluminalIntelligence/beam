import { contextBridge, ipcRenderer } from "electron";

/** The whole bridge. Keep it small; the renderer talks to Convex for everything else. */
contextBridge.exposeInMainWorld("beam", {
  platform: process.platform,
  openTerminalWith: (command: string) => ipcRenderer.invoke("beam:openTerminalWith", command),
  pickFolder: () => ipcRenderer.invoke("beam:pickFolder"),
  openExternal: (url: string) => ipcRenderer.invoke("beam:openExternal", url),
  runnerStatus: () => ipcRenderer.invoke("beam:runnerStatus"),
  restartRunner: () => ipcRenderer.invoke("beam:restartRunner"),
  onPairCode: (cb: (code: string) => void) => { const h = (_e: unknown, code: string) => cb(code); ipcRenderer.on("beam:pair", h); return () => ipcRenderer.off("beam:pair", h); },
  updateStatus: () => ipcRenderer.invoke("beam:update:status"),
  updateCheck: () => ipcRenderer.invoke("beam:update:check"),
  updateDownload: () => ipcRenderer.invoke("beam:update:download"),
  updateInstall: () => ipcRenderer.invoke("beam:update:install"),
  onUpdate: (cb: (u: unknown) => void) => { const h = (_e: unknown, u: unknown) => cb(u); ipcRenderer.on("beam:update", h); return () => ipcRenderer.off("beam:update", h); },
  version: () => ipcRenderer.invoke("beam:version"),
  onRunnerLog: (cb: (line: string) => void) => { const h = (_e: unknown, l: string) => cb(l); ipcRenderer.on("beam:runnerLog", h); return () => ipcRenderer.off("beam:runnerLog", h); },
});
