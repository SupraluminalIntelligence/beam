import { useSyncExternalStore } from "react";

/** Per-person UI state: which workspace, which tabs, which chat. Never shared. */
export interface UiState {
  ws: string | null;
  tabs: Record<string, string[]>;
  active: Record<string, string | null>;
  prefs: { addToChat: "auto" | "ask" };
  collapsed: Record<string, boolean>;   // workspace id → thread list folded
  sidebarWidth: number;                 // px, dragged from the panel's right edge
}
const KEY = "beam.ui.v1";
let state: UiState = load();
const subs = new Set<() => void>();

function load(): UiState {
  try { const raw = localStorage.getItem(KEY); if (raw) return { prefs: { addToChat: "auto" }, collapsed: {}, sidebarWidth: 240, ...JSON.parse(raw) }; } catch {}
  return { ws: null, tabs: {}, active: {}, prefs: { addToChat: "auto" }, collapsed: {}, sidebarWidth: 240 };
}
function set(next: UiState) { state = next; try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {} subs.forEach((f) => f()); }

export const ui = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  setWorkspace: (ws: string) => set({ ...state, ws, collapsed: { ...state.collapsed, [ws]: false } }),
  setSidebarWidth: (w: number) => set({ ...state, sidebarWidth: Math.round(Math.min(440, Math.max(200, w))) }),
  toggleCollapsed: (ws: string) => set({ ...state, collapsed: { ...state.collapsed, [ws]: !state.collapsed[ws] } }),
  openChat: (ws: string, chat: string) => {
    const tabs = state.tabs[ws] ?? [];
    set({ ...state, ws, tabs: { ...state.tabs, [ws]: tabs.includes(chat) ? tabs : [...tabs, chat] }, active: { ...state.active, [ws]: chat } });
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
