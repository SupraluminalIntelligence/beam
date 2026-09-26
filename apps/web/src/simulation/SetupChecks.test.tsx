import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { channelSetupChecks, defaultChannel, type ChannelCase } from "@beam/contracts";
import { SetupChecks, checkSummary, flagged } from "./SetupChecks";

const hfe: ChannelCase = { ...defaultChannel, velocity: .01, nu: 3.8e-7, pr: 9.8, density: 1510, inletTemperature: 293.15, wallTemperature: 353.15, beta: 1.8e-3, boilingPoint: 334.15 };

it("marks failing assumptions and explains only the ones that need attention", () => {
  const checks = channelSetupChecks(hfe), html = renderToStaticMarkup(<SetupChecks checks={checks} />);
  expect(html).toContain('sim-check fail');
  expect(html).toContain("above the stated boiling point");
  expect(html).not.toContain('sim-check-note ok');
  expect(checkSummary(checks)).toBe("2 fail");
  expect(flagged(checks).map(c => c.id)).toEqual(["buoyancy", "single-phase"]);
  expect(checkSummary(channelSetupChecks(defaultChannel))).toBe("2 need fluid data");
});
