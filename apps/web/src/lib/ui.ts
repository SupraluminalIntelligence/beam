import { cadFormat, type CadReference } from "../cad/model";
import { useSyncExternalStore } from "react";
export interface PanelState { cadReference?: CadReference | null; open: boolean; tabs: string[]; active: string | null; width: number; maximized: boolean; selectedFile?: string | null; selectedSource?: string | null; contextScope?: "chat" | "workspace"; browserUrl?: string; browserHome?: boolean; browserHistory?: {url:string;at:number}[] }
export const emptyPanel: PanelState = { open: false, tabs: [], active: null, width: 520, maximized: false };

/** Per-person UI state: which workspace, which tabs, which chat. Never shared. */
export interface UiState {
  pinnedChats: Record<string, { workspaceId: string; chatId: string }[]>;
  sidebarHidden: boolean;
  navigation: { ws: string; chat: string | null }[];
  navigationIndex: number;
  ws: string | null;
  tabs: Record<string, string[]>;
  active: Record<string, string | null>;
  prefs: { addToChat: "auto" | "ask" };
  collapsed: Record<string, boolean>;   // workspace id → thread list folded
  sidebarWidth: number;                 // px, dragged from the panel's right edge
  panels: Record<string, PanelState>;
}
const KEY = "beam.ui.v1";
let state: UiState = load();
const subs = new Set<() => void>();

function load(): UiState {
  try { const raw = localStorage.getItem(KEY); if (raw) return { pinnedChats: {}, sidebarHidden: false, navigation: [], navigationIndex: -1, prefs: { addToChat: "auto" }, collapsed: {}, sidebarWidth: 240, panels: {}, ...JSON.parse(raw) }; } catch {}
  return { ws: null, tabs: {}, active: {}, pinnedChats: {}, sidebarHidden: false, navigation: [], navigationIndex: -1, prefs: { addToChat: "auto" }, collapsed: {}, sidebarWidth: 240, panels: {} };
}
function set(next: UiState) { state = next; try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {} subs.forEach((f) => f()); }

function navigate(next: UiState) {
  const target = { ws: next.ws!, chat: next.ws ? next.active[next.ws] ?? null : null };
  let history = state.navigation.slice(0, state.navigationIndex + 1);
  if (!history.length && state.ws) history = [{ ws: state.ws, chat: state.active[state.ws] ?? null }];
  const last = history.at(-1);
  if (last?.ws !== target.ws || last.chat !== target.chat) history.push(target);
  history = history.slice(-100);
  set({ ...next, navigation: history, navigationIndex: history.length - 1 });
}

export const ui = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  togglePin: (user: string, workspaceId: string, chatId: string) => {
    const pins = state.pinnedChats[user] ?? [];
    set({ ...state, pinnedChats: { ...state.pinnedChats, [user]: pins.some(p => p.chatId === chatId) ? pins.filter(p => p.chatId !== chatId) : [...pins, { workspaceId, chatId }] } });
  },
  toggleSidebar: () => set({ ...state, sidebarHidden: !state.sidebarHidden }),
  navigateHistory: (direction: -1 | 1) => {
    const index = state.navigationIndex + direction, target = state.navigation[index];
    if (!target) return;
    const tabs = state.tabs[target.ws] ?? [];
    set({ ...state, ws: target.ws, navigationIndex: index, active: { ...state.active, [target.ws]: target.chat }, tabs: { ...state.tabs, [target.ws]: target.chat && !tabs.includes(target.chat) ? [...tabs, target.chat] : tabs }, collapsed: { ...state.collapsed, [target.ws]: false } });
  },
  panel: (chat: string, patch: Partial<PanelState>) => set({ ...state, panels: { ...state.panels, [chat]: { ...(state.panels[chat] ?? emptyPanel), ...patch } } }),
  openSurface: (chat: string, id: string) => {
    const panel = state.panels[chat] ?? emptyPanel;
    ui.panel(chat, { open: true, active: id, tabs: panel.tabs.includes(id) ? panel.tabs : [...panel.tabs, id] });
  },
  openContext: (chat: string) => {
    ui.panel(chat, { selectedFile: null, selectedSource: null, contextScope: "chat" });
    ui.openSurface(chat, "files");
  },
  openCad: (chat: string, reference: CadReference) => {
    ui.panel(chat, { cadReference: reference });
    ui.openSurface(chat, "cad");
  },
  openFile: (chat: string, file: string, name?: string) => {
    if (name && cadFormat(name)) { ui.openCad(chat, { kind: "file", id: file }); return; }
    ui.panel(chat, { selectedFile: file, selectedSource: null, contextScope: "chat" });
    ui.openSurface(chat, "files");
  },
  closeSurface: (chat: string, id: string) => {
    const panel = state.panels[chat] ?? emptyPanel, tabs = panel.tabs.filter(t => t !== id);
    ui.panel(chat, { tabs, active: panel.active === id ? tabs.at(-1) ?? null : panel.active });
  },
  setWorkspace: (ws: string) => navigate({ ...state, ws, collapsed: { ...state.collapsed, [ws]: false } }),
  setSidebarWidth: (w: number) => set({ ...state, sidebarWidth: Math.round(Math.min(440, Math.max(200, w))) }),
  toggleCollapsed: (ws: string) => set({ ...state, collapsed: { ...state.collapsed, [ws]: !state.collapsed[ws] } }),
  openChat: (ws: string, chat: string) => {
    const tabs = state.tabs[ws] ?? [];
    navigate({ ...state, ws, tabs: { ...state.tabs, [ws]: tabs.includes(chat) ? tabs : [...tabs, chat] }, active: { ...state.active, [ws]: chat } });
  },
  closeChat: (ws: string, chat: string) => {
    const tabs = state.tabs[ws] ?? [];
    const i = tabs.indexOf(chat);
    const next = tabs.filter((t) => t !== chat);
    const active = state.active[ws] === chat ? (next[Math.max(0, i - 1)] ?? null) : (state.active[ws] ?? null);
    set({ ...state, tabs: { ...state.tabs, [ws]: next }, active: { ...state.active, [ws]: active } });
  },
  setPref: <K extends keyof UiState["prefs"]>(k: K, v: UiState["prefs"][K]) => set({ ...state, prefs: { ...state.prefs, [k]: v } }),
};
export const useUi = () => useSyncExternalStore(ui.subscribe, ui.get);
