import { expect, it } from "vitest";
import { fieldColor, fieldGradient, fieldLut } from "./palette";

it("keeps both ends of the sequential scale visible on a dark background", () => {
  const [low, high] = [fieldColor(0, false), fieldColor(1, false)];
  expect(Math.max(...low)).toBeGreaterThan(0.6); // a clear blue, not Turbo's near-black purple
  expect(low[2]).toBeGreaterThan(low[0]);
  expect(high[0]).toBeGreaterThan(high[2]);
});

it("centres the diverging scale on a light neutral", () => {
  const mid = fieldColor(0.5, true);
  expect(mid.every(c => c > 0.8 && Math.abs(c - mid[0]) < 0.01)).toBe(true);
});

it("gives three.js linear light and the legend the same colours in sRGB", () => {
  const lut = fieldLut(false), s = fieldColor(1, false);
  expect(lut).toHaveLength(256);
  expect(lut[255]![0]).toBeCloseTo(((s[0] + 0.055) / 1.055) ** 2.4, 5);
  expect(fieldGradient(true)).toMatch(/^linear-gradient\(90deg, rgb\(59 76 192\), .*rgb\(180 4 38\)\)$/);
});
