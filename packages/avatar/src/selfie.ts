import type { AvatarRecipe } from "@vcr/protocol";
import { EYE_COLORS, hexToRgb, HAIR_COLORS, nearestSwatch, SKIN_TONES } from "./palette";

/**
 * Selfie assist (PLAN.md § 4.2): turns MediaPipe Face Landmarker landmarks and the photo's
 * pixels into creator settings. Runs entirely on the device. Proportions are measured relative
 * to face width, so distance from the camera doesn't matter; colors snap to the creator's
 * palettes, which keeps the look stylized and easy to correct.
 */

/** A landmark in normalized image coordinates (0–1), as MediaPipe returns them. */
export interface Landmark {
  x: number;
  y: number;
}

/** Just the parts of ImageData we read. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// MediaPipe face mesh landmark indices.
const L = {
  foreheadTop: 10,
  chin: 152,
  cheekRight: 234,
  cheekLeft: 454,
  jawRight: 172,
  jawLeft: 397,
  rightEyeOuter: 33,
  rightEyeInner: 133,
  leftEyeInner: 362,
  leftEyeOuter: 263,
  noseRight: 129,
  noseLeft: 358,
  mouthRight: 61,
  mouthLeft: 291,
  cheekPatchRight: 50,
  cheekPatchLeft: 280,
  forehead: 151,
  irisRight: 468,
  irisRightEdge: 469,
  irisLeft: 473,
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(clamp01(v) * 100) / 100;
/** Maps `value` from a typical [lo, hi] range onto a 0–1 slider. */
const toSlider = (value: number, lo: number, hi: number) => round((value - lo) / (hi - lo));

/** Face proportions → the creator's face sliders. `aspect` is image width / height. */
export function faceFromLandmarks(lm: Landmark[], aspect: number): AvatarRecipe["face"] {
  const d = (a: number, b: number) =>
    Math.hypot((lm[a]!.x - lm[b]!.x) * aspect, lm[a]!.y - lm[b]!.y);
  const width = d(L.cheekRight, L.cheekLeft);
  const height = d(L.foreheadTop, L.chin);
  const eyeWidth = (d(L.rightEyeOuter, L.rightEyeInner) + d(L.leftEyeInner, L.leftEyeOuter)) / 2;
  const length = toSlider(height / width, 1.15, 1.5);
  return {
    length,
    // Wider faces read as shorter ones; nudge width the other way for variety.
    width: round(0.5 + (0.5 - length) * 0.6),
    jaw: toSlider(d(L.jawRight, L.jawLeft) / width, 0.6, 0.82),
    eyeSize: toSlider(eyeWidth / width, 0.16, 0.25),
    eyeSpacing: toSlider(d(L.rightEyeInner, L.leftEyeInner) / width, 0.16, 0.28),
    noseSize: toSlider(d(L.noseRight, L.noseLeft) / width, 0.2, 0.34),
    mouthWidth: toSlider(d(L.mouthRight, L.mouthLeft) / width, 0.32, 0.48),
  };
}

type Rgb = [number, number, number];

/** Median color in a ring around (cx, cy) in pixels; medians shrug off highlights and shadows. */
function sample(px: Pixels, cx: number, cy: number, outer: number, inner = 0): Rgb | null {
  const values: Rgb[] = [];
  const r = Math.max(1, Math.round(outer));
  for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y++) {
    for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x++) {
      if (x < 0 || y < 0 || x >= px.width || y >= px.height) continue;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > outer || dist < inner) continue;
      const i = (y * px.width + x) * 4;
      values.push([px.data[i]!, px.data[i + 1]!, px.data[i + 2]!]);
    }
  }
  if (values.length === 0) return null;
  const median = (k: 0 | 1 | 2) => {
    const sorted = values.map((v) => v[k]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  return [median(0), median(1), median(2)];
}

const average = (colors: Rgb[]): Rgb =>
  [0, 1, 2].map((k) => colors.reduce((sum, c) => sum + c[k]!, 0) / colors.length) as Rgb;
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface SelfieColors {
  skin: string;
  /** Null when what's above the forehead looks like skin or background, not hair. */
  hair: string | null;
  eyeColor: string | null;
}

/** Samples skin, hair and eye colors from the photo and snaps them to the creator's palettes. */
export function colorsFromPhoto(lm: Landmark[], px: Pixels): SelfieColors {
  const at = (i: number) => ({ x: lm[i]!.x * px.width, y: lm[i]!.y * px.height });
  const faceWidth = Math.hypot(
    at(L.cheekRight).x - at(L.cheekLeft).x,
    at(L.cheekRight).y - at(L.cheekLeft).y,
  );
  const patch = faceWidth * 0.045;

  const skinSamples = [L.cheekPatchRight, L.cheekPatchLeft, L.forehead]
    .map((i) => sample(px, at(i).x, at(i).y, patch))
    .filter((c): c is Rgb => c !== null);
  const skinRgb = skinSamples.length ? average(skinSamples) : hexToRgb(SKIN_TONES[4]);

  // Hair: just above the top of the forehead, and above each temple.
  const top = at(L.foreheadTop);
  const chin = at(L.chin);
  const up = { x: (top.x - chin.x) * 0.1, y: (top.y - chin.y) * 0.1 };
  const hairPoints = [
    { x: top.x + up.x, y: top.y + up.y },
    { x: at(L.cheekRight).x + up.x * 2.2, y: at(L.cheekRight).y + up.y * 3.2 },
    { x: at(L.cheekLeft).x + up.x * 2.2, y: at(L.cheekLeft).y + up.y * 3.2 },
  ];
  const hairSamples = hairPoints
    .map((p) => sample(px, p.x, p.y, patch))
    .filter((c): c is Rgb => c !== null)
    // Anything close to the skin color is forehead or a bald head, not hair.
    .filter((c) => distance(c, skinRgb) > 45);
  const hair = hairSamples.length >= 2 ? nearestSwatch(average(hairSamples), HAIR_COLORS) : null;

  // Eyes: a ring inside each iris, skipping the pupil and the eye's edge.
  let eyeColor: string | null = null;
  if (lm.length > L.irisLeft) {
    const iris = at(L.irisRight);
    const edge = at(L.irisRightEdge);
    const radius = Math.hypot(iris.x - edge.x, iris.y - edge.y);
    const rings = [at(L.irisRight), at(L.irisLeft)]
      .map((c) => sample(px, c.x, c.y, radius * 0.85, radius * 0.45))
      .filter((c): c is Rgb => c !== null);
    if (rings.length) eyeColor = nearestSwatch(average(rings), EYE_COLORS);
  }

  return { skin: nearestSwatch(skinRgb, SKIN_TONES), hair, eyeColor };
}

/** Applies a selfie's measurements and colors to a recipe, keeping every other choice. */
export function applySelfie(
  recipe: AvatarRecipe,
  face: AvatarRecipe["face"],
  colors: SelfieColors,
): AvatarRecipe {
  return {
    ...recipe,
    face,
    skin: colors.skin,
    eyeColor: colors.eyeColor ?? recipe.eyeColor,
    hair: colors.hair ? { ...recipe.hair, color: colors.hair } : recipe.hair,
  };
}
