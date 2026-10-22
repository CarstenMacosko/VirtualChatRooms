/**
 * Color swatches the creator offers. Selfie assist snaps sampled colors to these, which keeps the
 * look stylized and lets people fix a bad guess with one click.
 */

export const SKIN_TONES = [
  "#fde3cf",
  "#f6d2b5",
  "#ecbf9b",
  "#e0ac85",
  "#d29a6e",
  "#c1865b",
  "#a96f47",
  "#8f5a38",
  "#77482c",
  "#5f3922",
  "#4a2c1b",
  "#3a2216",
] as const;

export const HAIR_COLORS = [
  "#14100e",
  "#2b1d16",
  "#4a3022",
  "#6b4429",
  "#8c5a33",
  "#b07a43",
  "#d1a462",
  "#e8cc8e",
  "#a33a22",
  "#c8c4c0",
  "#7d7a78",
  "#f2f0ec",
  "#3c4cc2",
  "#d14f9a",
  "#3aa58a",
] as const;

export const EYE_COLORS = [
  "#3b2418",
  "#5a3a22",
  "#7a5a2e",
  "#6f7b3a",
  "#3f7a4f",
  "#3d6c9e",
  "#6a8fb3",
  "#6e7378",
] as const;

export const CLOTHING_COLORS = [
  "#1f2433",
  "#f2f2f2",
  "#d93d3d",
  "#f08a24",
  "#f2c230",
  "#4cb562",
  "#2f9e94",
  "#3478d4",
  "#5b4fcf",
  "#a24fc9",
  "#e5609a",
  "#8a5a3b",
  "#7a8a99",
  "#2c4a7a",
] as const;

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** CIE Lab, so "nearest color" matches how people see color differences. */
function toLab([r, g, b]: Rgb): Rgb {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The swatch closest to `rgb`. */
export function nearestSwatch(rgb: Rgb, palette: readonly string[]): string {
  const target = toLab(rgb);
  let best = palette[0]!;
  let bestDistance = Infinity;
  for (const hex of palette) {
    const lab = toLab(hexToRgb(hex));
    const d = Math.hypot(lab[0] - target[0], lab[1] - target[1], lab[2] - target[2]);
    if (d < bestDistance) {
      bestDistance = d;
      best = hex;
    }
  }
  return best;
}

/** Mixes two hex colors; `t` = 0 gives `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
