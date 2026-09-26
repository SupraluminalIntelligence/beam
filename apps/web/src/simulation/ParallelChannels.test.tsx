import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { defaultParallelChannels as mana, parallelLayout, type ParallelChannelsResults, type SimulationFields, type SimulationReport } from "@beam/contracts";
import { FlowHistoryPlot, ParallelDrawing, ParallelMeasurements, ParallelRail } from "./ParallelChannels";

// Rounded from a 5 s Beam run of the default device: the heated lower channel draws 57 % of the flow and no heat has reached the outlet yet.
const results: ParallelChannelsResults = {
  inflow: 1.5e-4, flows: [8.5e-5, 6.5e-5], history: [{ time: 0.25, flows: [7.5e-5, 7.5e-5] }, { time: 5, flows: [8.5e-5, 6.5e-5] }],
  exitBulkTemperaturesK: [296.5, 293.15], maxHeatedWallTemperatureK: 351.85, heatInputW: 1050, heatCarriedOutW: 0.1,
};
const report = { physicalTime: 5, parallel: results } as SimulationReport;

it("lays out each channel's heating and every input the case needs", () => {
  const html = renderToStaticMarkup(<ParallelRail config={mana} change={() => {}} />);
  expect(html).toContain('aria-label="channel 1" type="number" step="any" value="0.75"');
  expect(html).toContain('aria-label="channel 2" type="number" step="any" value="0"');
  expect(html).toContain('<option value="stacked" selected="">down · 1 lowest</option>');
});

it("draws heated walls, flow direction and gravity before a solve, and one rectangle per cell after", () => {
  const empty = renderToStaticMarkup(<ParallelDrawing config={mana} fields={null} field="velocity" />);
  expect(empty).toContain("2 channels 5 mm high and 70 mm long between manifolds");
  expect(empty).toContain("0.75 W/cm²");
  expect(empty).toContain("INLET");
  expect(empty).toContain("Vertical scale enlarged");
  const cells = parallelLayout(mana).cells, fields: SimulationFields = { version: 1, centres: Array.from({ length: cells }, (_, i) => [0.001 + (i % 100) * 0.002, 0.0001, 0] as [number, number, number]), velocity: Array(cells).fill(0.01), pressure: Array(cells).fill(0), temperature: Array(cells).fill(293.15) };
  const solved = renderToStaticMarkup(<ParallelDrawing config={mana} fields={fields} field="temperature" />);
  expect(solved.match(/<title>/g)).toHaveLength(cells);
});

it("reports the flow split, the hottest wall against the boiling point and how much heat has left", () => {
  const html = renderToStaticMarkup(<ParallelMeasurements config={mana} report={report} />);
  expect(html).toContain("channel 1 · heated</span><span>56.7 % · 0.85 cm²/s");
  expect(html).toContain("78.7 °C");
  expect(html).toContain("above Tsat");
  expect(html).toContain("0.00952 % of 1050 W/m");
  expect(html).toContain("has not reached a thermal steady state");
  expect(renderToStaticMarkup(<ParallelMeasurements config={mana} report={null} />)).toContain("appear after a solve");
});

it("plots every channel's flow over time with an even-split reference", () => {
  const html = renderToStaticMarkup(<FlowHistoryPlot config={mana} results={results} />);
  expect(html).toContain("channel 1 · heated 56.7 %, channel 2 43.3 % of the inflow");
  expect(html).toContain("even split");
  expect(html.match(/<polyline/g)).toHaveLength(2);
});
