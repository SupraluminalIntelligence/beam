/** The optional preload bridge. Undefined in a browser; present in Electron. Never required. */
export interface BeamBridge {
  platform: "darwin" | "win32" | "linux";
  openTerminalWith(command: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  runnerStatus(): Promise<{ running: boolean; pid: number | null; pendingPair: string | null; log: string[] }>;
  restartRunner(): Promise<void>;
  onPairCode(cb: (code: string) => void): () => void;
  onRunnerLog(cb: (line: string) => void): () => void;
}
declare global { interface Window { beam?: BeamBridge } }
export const bridge = (): BeamBridge | undefined => (typeof window === "undefined" ? undefined : window.beam);
