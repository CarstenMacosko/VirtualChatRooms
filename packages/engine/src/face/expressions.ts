import { ARKIT_INDEX, type ArkitBlendshape } from "@vcr/protocol";

/** VRM 1.0 expression presets our avatars implement. */
export const VRM_EXPRESSIONS = [
  "blinkLeft",
  "blinkRight",
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
  "happy",
  "angry",
  "sad",
  "surprised",
  "relaxed",
] as const;
export type VrmExpression = (typeof VRM_EXPRESSIONS)[number];
export type ExpressionWeights = Record<VrmExpression, number>;

export const neutralExpressions = (): ExpressionWeights =>
  Object.fromEntries(VRM_EXPRESSIONS.map((e) => [e, 0])) as ExpressionWeights;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Maps ARKit blendshapes (0–255 each, as they arrive in `AvatarPose.face`) onto our stylized
 * avatar's few, exaggerated expressions. Gains are tuned so a natural smile reads as a big one.
 */
export function arkitToVrm(face: Uint8Array): ExpressionWeights {
  const w = (name: ArkitBlendshape) => (face[ARKIT_INDEX[name]] ?? 0) / 255;
  const both = (l: ArkitBlendshape, r: ArkitBlendshape) => (w(l) + w(r)) / 2;
  return {
    blinkLeft: clamp01((w("eyeBlinkLeft") - 0.15) * 1.4),
    blinkRight: clamp01((w("eyeBlinkRight") - 0.15) * 1.4),
    aa: clamp01(w("jawOpen") * 1.4),
    ih: clamp01(both("mouthUpperUpLeft", "mouthUpperUpRight") * 0.8),
    ou: clamp01(w("mouthPucker") * 1.3),
    ee: clamp01(both("mouthStretchLeft", "mouthStretchRight") * 1.6),
    oh: clamp01(w("mouthFunnel") * 1.4),
    happy: clamp01((both("mouthSmileLeft", "mouthSmileRight") - 0.08) * 1.6),
    angry: clamp01((both("browDownLeft", "browDownRight") - 0.1) * 1.5),
    sad: clamp01(both("mouthFrownLeft", "mouthFrownRight") * 1.8 + w("browInnerUp") * 0.2),
    surprised: clamp01(
      (w("browInnerUp") +
        both("browOuterUpLeft", "browOuterUpRight") +
        both("eyeWideLeft", "eyeWideRight")) *
        0.55 -
        0.15,
    ),
    relaxed: 0,
  };
}
