import { describe, expect, it } from "vitest";
import { hexToRgb } from "../src/palette";
import { applySelfie, colorsFromPhoto, faceFromLandmarks, type Landmark } from "../src/selfie";
import { recipeForSeed } from "../src/defaults";

/** A synthetic, average-proportioned face in a 400×400 photo. */
function face(overrides: Record<number, Landmark> = {}): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (i: number, x: number, y: number) => (lm[i] = { x, y });
  set(234, 0.3, 0.5); // cheeks: face width 0.4
  set(454, 0.7, 0.5);
  set(10, 0.5, 0.25); // forehead → chin: height 0.53 (ratio ~1.33)
  set(152, 0.5, 0.78);
  set(172, 0.36, 0.66); // jaw 0.28 → 0.7 of width
  set(397, 0.64, 0.66);
  set(33, 0.38, 0.45); // eyes 0.08 wide each, one eye-width apart (the rule of fifths)
  set(133, 0.46, 0.45);
  set(362, 0.54, 0.45);
  set(263, 0.62, 0.45);
  set(129, 0.445, 0.56); // nose 0.11 → 0.275
  set(358, 0.555, 0.56);
  set(61, 0.42, 0.65); // mouth 0.16 → 0.4
  set(291, 0.58, 0.65);
  set(50, 0.38, 0.55);
  set(280, 0.62, 0.55);
  set(151, 0.5, 0.3);
  set(468, 0.42, 0.45); // irises, radius 0.015
  set(469, 0.435, 0.45);
  set(473, 0.58, 0.45);
  for (const [i, v] of Object.entries(overrides)) lm[Number(i)] = v;
  return lm;
}

function photo(paint: (x: number, y: number) => string, size = 400) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = hexToRgb(paint(x / size, y / size));
      data.set([r, g, b, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

describe("selfie assist", () => {
  it("puts an average face near the middle of every slider", () => {
    const sliders = faceFromLandmarks(face(), 1);
    for (const [name, value] of Object.entries(sliders)) {
      expect(value, name).toBeGreaterThan(0.25);
      expect(value, name).toBeLessThan(0.75);
    }
  });

  it("measures relative to face width, so distance from the camera doesn't matter", () => {
    const near = faceFromLandmarks(face(), 1);
    const far = faceFromLandmarks(
      face().map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.5, y: 0.5 + (p.y - 0.5) * 0.5 })),
      1,
    );
    expect(far).toEqual(near);
  });

  it("notices wide-set eyes and a wide mouth", () => {
    const sliders = faceFromLandmarks(
      face({
        133: { x: 0.44, y: 0.45 },
        362: { x: 0.56, y: 0.45 },
        61: { x: 0.39, y: 0.65 },
        291: { x: 0.61, y: 0.65 },
      }),
      1,
    );
    expect(sliders.eyeSpacing).toBeGreaterThan(0.75);
    expect(sliders.mouthWidth).toBeGreaterThan(0.9);
  });

  it("samples skin, hair and eye colors and snaps them to the palettes", () => {
    const skin = "#c1865b";
    const pixels = photo((x, y) => {
      if (Math.hypot(x - 0.42, y - 0.45) < 0.013 || Math.hypot(x - 0.58, y - 0.45) < 0.013) {
        return "#3d6c9e"; // blue irises
      }
      if (y < 0.24 || (y < 0.42 && (x < 0.31 || x > 0.69))) return "#2b1d16"; // dark hair
      return skin;
    });
    const colors = colorsFromPhoto(face(), pixels);
    expect(colors).toEqual({ skin, hair: "#2b1d16", eyeColor: "#3d6c9e" });
  });

  it("doesn't invent hair when there's only skin above the forehead", () => {
    const colors = colorsFromPhoto(
      face(),
      photo(() => "#e0ac85"),
    );
    expect(colors.hair).toBeNull();
    const recipe = recipeForSeed("bald test");
    expect(applySelfie(recipe, recipe.face, colors).hair).toEqual(recipe.hair);
  });
});
