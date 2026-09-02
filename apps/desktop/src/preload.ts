import { contextBridge, ipcRenderer } from "electron";

/** The whole bridge. Keep it small; the renderer talks to Convex for everything else. */
contextBridge.exposeInMainWorld("beam", {
  platform: process.platform,
  openTerminalWith: (command: string) => ipcRenderer.invoke("beam:openTerminalWith", command),
  pickFolder: () => ipcRenderer.invoke("beam:pickFolder"),
  openExternal: (url: string) => ipcRenderer.invoke("beam:openExternal", url),
  runnerStatus: () => ipcRenderer.invoke("beam:runnerStatus"),
});
