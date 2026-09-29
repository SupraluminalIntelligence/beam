// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppBoundary, RowBoundary } from "./Boundary";

// What blanked 0.1.10: a study written by a newer backend, parsed during render with a schema that predates it.
function StudyCard({ geometry }: { geometry: string }) {
  if (geometry !== "channel") throw new Error('Invalid literal value, expected "channel"');
  return <div>{geometry} study</div>;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | null = null;
function render(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("render errors", () => {
  it("replace only the chat row that threw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = render(<AppBoundary>
      <RowBoundary><StudyCard geometry="domain3d" /></RowBoundary>
      <RowBoundary><StudyCard geometry="channel" /></RowBoundary>
    </AppBoundary>);
    expect(el.textContent).toContain("This message could not be shown");
    expect(el.textContent).toContain("channel study");
    expect(el.querySelector("[role=alert]")).toBeNull();
  });

  it("outside any row, show a reload screen instead of a blank window", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = render(<AppBoundary><StudyCard geometry="domain3d" /></AppBoundary>);
    expect(el.querySelector("[role=alert]")?.textContent).toContain("Beam hit an error");
    expect(Array.from(el.querySelectorAll("button"), b => b.textContent)).toContain("Reload");
  });
});
