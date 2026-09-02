/** The optional preload bridge. Undefined in a browser; present in Electron. Never required. */
export interface BeamBridge {
  platform: "darwin" | "win32" | "linux";
  openTerminalWith(command: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  runnerStatus(): Promise<{ running: boolean; pid: number | null }>;
}
declare global { interface Window { beam?: BeamBridge } }
export const bridge = (): BeamBridge | undefined => (typeof window === "undefined" ? undefined : window.beam);
