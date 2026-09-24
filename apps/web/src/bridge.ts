/** The optional preload bridge. Undefined in a browser; present in Electron. Never required. */
export interface BeamBridge {
  browserPreview?: boolean;
  localServers?(): Promise<{url:string;port:number;processName:string}[]>;
  platform: "darwin" | "win32" | "linux";
  notify?(value: { id: string; title: string; body: string; silent: boolean; workspaceId?: string; chatId?: string; messageId?: string }): Promise<boolean>;
  onNotificationClick?(cb: (value: { id: string; workspaceId: string; chatId: string; messageId?: string }) => void): () => void;
  openTerminalWith(command: string): Promise<void>;
  clipboardFiles?(): Promise<{name:string;base64:string}[]>;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  runnerStatus(): Promise<{ running: boolean; pid: number | null; pendingPair: string | null; log: string[] }>;
  restartRunner(): Promise<void>;
  onPairCode(cb: (code: string) => void): () => void;
  onRunnerLog(cb: (line: string) => void): () => void;
}
declare global { interface Window { beam?: BeamBridge } }
export const bridge = (): BeamBridge | undefined => (typeof window === "undefined" ? undefined : window.beam);
