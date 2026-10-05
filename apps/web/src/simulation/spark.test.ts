import { expect, it } from "vitest";
import type { LiveView } from "@beam/contracts";
import { spark } from "./spark";

const series = (name: string, values: (number | null)[], scale: "log" | "linear" = "linear") => ({ name, label: name, x: { label: "iteration", unit: "" }, y: { unit: "1", scale }, xs: values.map((_, i) => i + 1), lines: [{ name: "a", values }] });
const view = (s: ReturnType<typeof series>[]) => ({ series: s } as unknown as LiveView);

it("draws drag over residuals, newest at the right, and a log series by its logarithm", () => {
  expect(spark(view([series("residuals", [1, 0.1], "log"), series("coeff-Cd", [0.02, 0.01])]), 100, 10)).toEqual({ label: "coeff-Cd, a", points: "0.0,2.0 100.0,8.0" });
  expect(spark(view([series("residuals", [1, 0.1, 0.01], "log")]), 100, 10)!.points).toBe("0.0,2.0 50.0,5.0 100.0,8.0");
  expect(spark(view([series("coeff-Cd", [0.02, null]), series("residuals", [1, null, 0.01], "log")]), 100, 10)!.label).toBe("residuals, a");
  expect(spark(view([series("residuals", [1])]))).toBeNull();
});
