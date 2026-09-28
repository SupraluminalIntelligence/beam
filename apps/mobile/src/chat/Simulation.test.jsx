import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "convex/react";
import { SimulationCard } from "./Simulation";

vi.mock("react-native", () => ({
  View: ({ children }) => <div>{children}</div>,
  Pressable: ({ children, disabled }) => <button disabled={disabled}>{children}</button>,
  StyleSheet: { hairlineWidth: 1, create: (s) => s }, Platform: { OS: "web" },
}));
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: () => vi.fn() }));
vi.mock("expo-haptics", () => ({}));
vi.mock("../lib/convex", () => ({ api: { simulations: { get: "simulations.get" }, compute: { approve: "compute.approve" } } }));
vi.mock("../lib/theme", () => ({ useTheme: () => ({}), radius: {} }));
vi.mock("../ui", () => ({ T: ({ children }) => <span>{children}</span>, Sq: () => null }));

const results = { headline: [{ name: "tip", label: "Tip deflection", value: 4.764e-4, unit: "m", uncertainty: { kind: "gci", relative: 0.0004 } }], checks: { pass: 4, review: 1, fail: 0 }, flagged: [{ id: "yield", label: "Below yield", status: "review", value: "30%" }] };
const sim = (jobs) => ({ name: "Steel cantilever", version: 4, jobs });
beforeEach(() => vi.mocked(useQuery).mockReset());

describe("the simulation card on the phone", () => {
  it("shows the latest results with units, checks and what needs review", () => {
    vi.mocked(useQuery).mockReturnValue(sim([{ _id: "j1", version: 1, state: "succeeded", results, requestedBy: "me" }]));
    const html = renderToStaticMarkup(<SimulationCard id="s" me="me" />);
    expect(html).toContain("Tip deflection");
    expect(html).toContain("476.4 µm ±0.04%");
    expect(html).toContain("4 pass · 1 to review");
    expect(html).toContain("Below yield · 30%");
    expect(html).not.toContain("Approve and run");
  });
  it("offers Approve only to the person who requested the waiting job", () => {
    const waiting = { _id: "j2", version: 2, state: "awaiting-approval", requestedBy: "me", title: "Steel cantilever v2", environment: "fea" };
    vi.mocked(useQuery).mockReturnValue(sim([waiting]));
    expect(renderToStaticMarkup(<SimulationCard id="s" me="me" />)).toContain("Approve and run");
    expect(renderToStaticMarkup(<SimulationCard id="s" me="someone-else" />)).not.toContain("Approve and run");
  });
});
