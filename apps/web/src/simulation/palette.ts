/**
 * Colour scales for 3D fields. Sequential is Turbo (a perceptually smoothed rainbow, as structural
 * codes show stress); diverging is cool-to-warm (Moreland), whose light middle still reads as a lit
 * surface rather than a shadow. Values are sRGB, 0–1.
 */
type RGB = [number, number, number];

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Turbo, from its published polynomial fit, starting at its blue: its darkest tenth would vanish into a dark background. */
function turbo(t: number): RGB {
  const x = 0.1 + 0.9 * clamp(t);
  return [
    0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943)))),
    0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604)))),
    0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973)))),
  ].map(clamp) as RGB;
}

const COOLWARM: RGB[] = [[59, 76, 192], [98, 130, 234], [141, 176, 254], [184, 208, 249], [221, 221, 221], [245, 196, 173], [244, 154, 123], [222, 96, 77], [180, 4, 38]].map(c => c.map(v => v / 255) as RGB);
function coolwarm(t: number): RGB {
  const x = clamp(t) * (COOLWARM.length - 1), i = Math.min(COOLWARM.length - 2, Math.floor(x)), f = x - i, a = COOLWARM[i]!, b = COOLWARM[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const fieldColor = (t: number, diverging: boolean): RGB => (diverging ? coolwarm : turbo)(t);

/** sRGB to linear light, which is what three.js expects of vertex colours. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** 256 entries in linear light, for vertex colours. */
export const fieldLut = (diverging: boolean) => Array.from({ length: 256 }, (_, i) => fieldColor(i / 255, diverging).map(linear) as RGB);

/** The same scale as a CSS gradient, for the legend. */
export const fieldGradient = (diverging: boolean) =>
  `linear-gradient(90deg, ${Array.from({ length: 9 }, (_, i) => `rgb(${fieldColor(i / 8, diverging).map(v => Math.round(v * 255)).join(" ")})`).join(", ")})`;
