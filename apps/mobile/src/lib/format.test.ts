import { describe, expect, it } from "vitest";
import { errorText } from "./format";

describe("errorText", () => {
  it("pulls the server's message out of a Convex error", () => {
    const e = new Error("[CONVEX M(runs:respond)] [Request ID: abc] Server Error\nUncaught Error: no such run\n    at handler (../convex/runs.ts:208:20)");
    expect(errorText(e)).toBe("no such run");
  });

  it("keeps the first line of any other error", () => {
    expect(errorText(new Error("Network request failed\nmore"))).toBe("Network request failed");
    expect(errorText("boom")).toBe("boom");
  });

  it("never returns an empty line", () => {
    expect(errorText(new Error(""))).toBe("Something went wrong. Try again.");
  });
});
