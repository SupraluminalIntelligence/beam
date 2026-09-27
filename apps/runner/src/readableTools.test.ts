import { expect, it } from "vitest";
import { readableTools } from "./runs.ts";

it("gives an agent the reason a Beam tool was refused, not Convex's wrapping", async () => {
  const refused = Object.assign(new Error("[CONVEX M(compute:submitSimulationForRun)] [Request ID: 784baf1f10d702a7] Server Error"), { data: "Select this study explicitly before running it" });
  const [tool] = readableTools([
    { name: "run_simulation", description: "", schema: {}, run: async () => { throw refused; } },
  ]);
  await expect(tool!.run({})).rejects.toThrow(/^Select this study explicitly before running it$/);
  const [ok] = readableTools([{ name: "list_repos", description: "", schema: {}, run: async () => "fine" }]);
  expect(await ok!.run({})).toBe("fine");
});
