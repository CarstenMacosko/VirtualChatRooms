import {
  AVATAR_RECIPE_VERSION,
  type AvatarRecipe,
  Bottom,
  FacialHair,
  Glasses,
  HairStyle,
  Hat,
  Top,
} from "@vcr/protocol";
import { CLOTHING_COLORS, EYE_COLORS, HAIR_COLORS, SKIN_TONES } from "./palette";

/** Small seeded PRNG (mulberry32) so a seed always gives the same avatar. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)]!;
/** Mostly near the middle: random sliders shouldn't produce extreme faces. */
const slider = (random: () => number) => Math.round((0.25 + random() * 0.5) * 100) / 100;

/** A random but reasonable avatar ("Surprise me", and everyone's look before they make one). */
export function randomRecipe(random: () => number = Math.random): AvatarRecipe {
  const hairStyle = pick(
    random,
    HairStyle.options.filter((s) => s !== "bald"),
  );
  // Natural hair colors most of the time; the fun ones occasionally.
  const hairColor = pick(random, random() < 0.85 ? HAIR_COLORS.slice(0, 11) : HAIR_COLORS);
  const top = pick(random, Top.options);
  return {
    version: AVATAR_RECIPE_VERSION,
    body: { height: slider(random), build: slider(random) },
    skin: pick(random, SKIN_TONES),
    face: {
      width: slider(random),
      length: slider(random),
      jaw: slider(random),
      eyeSize: slider(random),
      eyeSpacing: slider(random),
      noseSize: slider(random),
      mouthWidth: slider(random),
    },
    eyeColor: pick(random, EYE_COLORS),
    hair: { style: hairStyle, color: hairColor },
    facialHair: random() < 0.8 ? "none" : pick(random, FacialHair.options),
    outfit: {
      top,
      topColor: pick(random, CLOTHING_COLORS),
      bottom: pick(random, Bottom.options),
      bottomColor: pick(random, CLOTHING_COLORS),
      shoesColor: pick(random, CLOTHING_COLORS),
    },
    glasses: random() < 0.75 ? "none" : pick(random, Glasses.options),
    hat: {
      style: random() < 0.85 ? "none" : pick(random, Hat.options),
      color: pick(random, CLOTHING_COLORS),
    },
  };
}

/** The look someone has before making their own avatar: stable per person. */
export const recipeForSeed = (seed: string) => randomRecipe(seededRandom(seed));
