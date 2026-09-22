import { ui, useUi } from "../lib/ui";

export function NavigationControls() {
  const state = useUi();
  return <nav className="app-navigation" aria-label="Navigation">
    <button className="nav-icon" title={state.sidebarHidden ? "Show sidebar" : "Hide sidebar"} aria-label="Toggle sidebar" aria-expanded={!state.sidebarHidden} onClick={ui.toggleSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>
    <button className="nav-icon" title="Back" aria-label="Back" disabled={state.navigationIndex <= 0} onClick={() => ui.navigateHistory(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h15"/></svg></button>
    <button className="nav-icon" title="Forward" aria-label="Forward" disabled={state.navigationIndex >= state.navigation.length - 1} onClick={() => ui.navigateHistory(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5 7 7-7 7M4 12h15"/></svg></button>
  </nav>;
}
