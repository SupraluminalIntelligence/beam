import { bridge } from "./bridge";

/** M0 placeholder. The prototype (design/beam-app.html) is the spec for what goes here. */
export function App() {
  const b = bridge();
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div style={{ textAlign: "center", display: "grid", gap: 8 }}>
        <div className="mono" style={{ letterSpacing: ".12em", fontSize: 12, color: "var(--ink-3)" }}>SUPRALUMINAL INTELLIGENCE</div>
        <div style={{ fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 700, fontSize: 56, letterSpacing: "-.03em" }}>Beam</div>
        <div style={{ color: "var(--ink-2)" }}>Argue it out. Then beam it.</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 16 }}>
          {b ? `desktop · ${b.platform}` : "browser"} · {import.meta.env["VITE_CONVEX_URL"] ? "convex connected" : "no VITE_CONVEX_URL yet"}
        </div>
      </div>
    </div>
  );
}
