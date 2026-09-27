import { expect, it } from "vitest";
import { errorMessage } from "./errors.ts";

it("hands over the reason, not Convex's wrapping", () => {
  // What the Convex client throws for a ConvexError: its data is the sentence.
  const refusal = Object.assign(new Error("[CONVEX M(compute:submitSimulationForRun)] [Request ID: 1] Server Error"), { data: "Select this study explicitly before running it" });
  expect(errorMessage(refusal)).toBe("Select this study explicitly before running it");
  expect(errorMessage(new Error("[CONVEX M(compute:submitSimulationForRun)] [Request ID: 784baf1f10d702a7] Server Error"))).toBe("Server Error");
  expect(errorMessage(new Error("[CONVEX Q(v1/me:get)] [Request ID: 1] Server Error\nUncaught Error: nope\n  at x"))).toBe("nope");
  expect(errorMessage(new Error("plain local failure"))).toBe("plain local failure");
  expect(errorMessage("a string")).toBe("a string");
});
