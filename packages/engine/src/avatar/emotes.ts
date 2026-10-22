import type { EmoteId } from "@vcr/protocol";
import type { ExpressionWeights } from "../face/expressions";
import type { AnimatedBone } from "./ProceduralAnimator";

/** How long an emote plays (matches the emoji bubble above the avatar). */
export const EMOTE_DURATION_S = 2.5;

type BoneOverride = Partial<Record<AnimatedBone, [number, number, number]>>;

export interface EmoteFrame {
  bones: BoneOverride;
  hipsOffsetY?: number;
  face: Partial<ExpressionWeights>;
}

/**
 * Body + face for each emote at time `t` seconds into it. Rotations use the animator's
 * conventions: arms hang via Z rotation (left negative, right positive), positive Y on an upper
 * arm swings a right arm forward, and forearms bend with Y.
 */
export function emoteFrame(id: EmoteId, t: number): EmoteFrame {
  switch (id) {
    case "wave":
      return {
        bones: {
          rightUpperArm: [0, 0.25, -1.05],
          rightLowerArm: [0, 0, -0.35 + 0.45 * Math.sin(t * 11)],
          head: [0, -0.12, 0.08],
        },
        face: { happy: 0.7 },
      };
    case "thumbsUp":
      return {
        bones: {
          rightUpperArm: [0, 1.05, 0.55],
          rightLowerArm: [0, 1.25, 0],
          head: [0.05, 0, -0.06],
        },
        face: { happy: 0.75 },
      };
    case "heart":
      return {
        bones: {
          leftUpperArm: [0, -0.95, -0.85],
          rightUpperArm: [0, 0.95, 0.85],
          leftLowerArm: [0, -1.6, 0],
          rightLowerArm: [0, 1.6, 0],
          head: [0.08, 0, 0.12 * Math.sin(t * 3)],
        },
        face: { happy: 0.6, relaxed: 0.6 },
      };
    case "laugh": {
      const shake = Math.sin(t * 20);
      return {
        bones: {
          spine: [-0.08, 0, 0],
          chest: [-0.1 + 0.05 * shake, 0, 0],
          head: [-0.28 + 0.04 * shake, 0, 0],
          leftUpperArm: [0, -0.3, -1.05],
          rightUpperArm: [0, 0.3, 1.05],
        },
        face: { happy: 1, aa: 0.45 + 0.35 * Math.max(0, shake) },
      };
    }
    case "dance": {
      const beat = t * 6.5;
      const s = Math.sin(beat);
      return {
        hipsOffsetY: -0.04 * Math.abs(Math.sin(beat)),
        bones: {
          hips: [0, 0.3 * s, 0.08 * s],
          chest: [0, -0.25 * s, -0.1 * s],
          head: [0, 0.2 * s, 0.12 * s],
          leftUpperArm: [0, 0, 0.55 + 0.45 * s],
          rightUpperArm: [0, 0, -0.55 + 0.45 * s],
          leftLowerArm: [0, -0.9, 0],
          rightLowerArm: [0, 0.9, 0],
          leftUpperLeg: [-0.25 * Math.max(0, s), 0, 0],
          rightUpperLeg: [-0.25 * Math.max(0, -s), 0, 0],
          leftLowerLeg: [0.5 * Math.max(0, s), 0, 0],
          rightLowerLeg: [0.5 * Math.max(0, -s), 0, 0],
        },
        face: { happy: 0.85 },
      };
    }
  }
}

/** Fade in over the first 0.25 s and out over the last 0.35 s. */
export function emoteEnvelope(t: number): number {
  if (t < 0 || t > EMOTE_DURATION_S) return 0;
  return Math.min(1, t / 0.25, (EMOTE_DURATION_S - t) / 0.35);
}
