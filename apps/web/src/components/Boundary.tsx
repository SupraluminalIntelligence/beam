import { Component, type ReactNode } from "react";
import { UpdatePill } from "./Update";

/**
 * Keeps a render error inside the part of the page that threw. Convex deploys from main before a desktop release reaches
 * people, so an older app can receive data it cannot draw (0.1.10 met a 3D study it had no schema for). Without a boundary
 * React unmounts everything and the window goes blank.
 */
export class Boundary extends Component<{ fallback: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: unknown) { console.error(error); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

/** One chat row: a message this app cannot draw becomes a note, and the rest of the chat keeps working. */
export function RowBoundary({ children }: { children: ReactNode }) {
  return <Boundary fallback={() => <div><div className="tx row-error" role="status">This message could not be shown. It may need a newer Beam.</div></div>}>{children}</Boundary>;
}

/** Last resort for the whole app: say what broke and offer a reload, and the update when one is available. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return <Boundary fallback={(error) => <div className="app-error" role="alert">
    <b>Beam hit an error and could not show this page.</b>
    <span>Reload to try again. If it keeps happening, update Beam.</span>
    <div><button className="btn" onClick={() => location.reload()}>Reload</button><UpdatePill /></div>
    <details><summary>Details</summary><pre>{error.message.slice(0, 2000)}</pre></details>
  </div>}>{children}</Boundary>;
}
