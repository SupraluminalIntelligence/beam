import { expect, it } from "vitest";
import { typingLabel, typingNames } from "./typing";
it("hides your own activity, expires disconnected typists, and merges multiple devices", () => {
  expect(typingNames([{ login: "me", expiresAt: 200 }, { login: "george", expiresAt: 200 }, { login: "george", expiresAt: 300 }, { login: "old", expiresAt: 100 }], "me", 100)).toEqual(["george"]);
});
it("describes one, two, and several simultaneous typists", () => {
  expect(typingLabel([])).toBe("");
  expect(typingLabel(["George"])).toBe("George is typing…");
  expect(typingLabel(["Apek", "George"])).toBe("Apek and George are typing…");
  expect(typingLabel(["Apek", "George", "Sam"])).toBe("Apek, George and 1 other are typing…");
});
