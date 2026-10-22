import { LocoState } from "@vcr/protocol";
import { clamp, damp } from "../math";

/** VRM 1.0 humanoid bones this animator drives. */
export const ANIMATED_BONES = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "rightUpperArm",
  "rightLowerArm",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const;
export type AnimatedBone = (typeof ANIMATED_BONES)[number];

/** Euler XYZ rotations (radians) for normalized VRM bones, plus a vertical hips offset. */
export interface RigPose {
  bones: Record<AnimatedBone, [number, number, number]>;
  hipsOffsetY: number;
}

const ARM_DOWN = 1.25;
/** Meters travelled per full gait cycle (two steps). */
const STRIDE = 1.4;

/**
 * Placeholder animation computed from locomotion state and speed: idle breathing, a walk/run
 * cycle and an airborne pose, blended smoothly. Phase 3 replaces it with a clip library; the
 * avatar code only depends on `RigPose`, so that swap stays local.
 *
 * Conventions (avatar faces +Z, VRM normalized bones): a positive X rotation swings a leg or arm
 * backward and bends a knee; arms hang down via Z rotation.
 */
export class ProceduralAnimator {
  private phase = 0;
  private time = 0;
  private moveWeight = 0;
  private runWeight = 0;
  private airWeight = 0;

  update(dt: number, input: { loco: LocoState; speed: number; lookPitch?: number }): RigPose {
    this.time += dt;
    const airborne = input.loco === LocoState.jump || input.loco === LocoState.fall;
    const speed = airborne ? 0 : input.speed;
    this.moveWeight = damp(this.moveWeight, speed > 0.15 ? 1 : 0, 8, dt);
    this.runWeight = damp(this.runWeight, clamp((speed - 2) / 2, 0, 1), 6, dt);
    this.airWeight = damp(this.airWeight, airborne ? 1 : 0, 10, dt);
    this.phase = (this.phase + (dt * Math.PI * 2 * Math.max(speed, 0.5)) / STRIDE) % (Math.PI * 2);

    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const mw = this.moveWeight;
    const rw = this.runWeight;
    const legAmp = (0.45 + 0.35 * rw) * mw;
    const armAmp = (0.35 + 0.45 * rw) * mw;
    const kneeAmp = (0.6 + 0.6 * rw) * mw;
    const breathe = Math.sin(this.time * 1.7) * 0.025;
    const elbow = 0.15 + 0.25 * mw + 0.9 * rw;

    const ground: RigPose = {
      hipsOffsetY: -Math.abs(c) * 0.03 * mw - 0.04 * rw,
      bones: {
        hips: [0, 0.12 * s * mw, 0],
        spine: [0.04 * mw + 0.15 * rw, -0.06 * s * mw, 0],
        chest: [breathe, -0.1 * s * mw, 0],
        neck: [0, 0, 0],
        head: [(input.lookPitch ?? 0) * 0.6 - 0.05 * rw, 0, 0],
        leftUpperArm: [armAmp * s, 0, -ARM_DOWN + breathe],
        rightUpperArm: [-armAmp * s, 0, ARM_DOWN - breathe],
        leftLowerArm: [0, -elbow, 0],
        rightLowerArm: [0, elbow, 0],
        leftUpperLeg: [-legAmp * s, 0, 0],
        rightUpperLeg: [legAmp * s, 0, 0],
        leftLowerLeg: [0.05 + kneeAmp * Math.max(0, c), 0, 0],
        rightLowerLeg: [0.05 + kneeAmp * Math.max(0, -c), 0, 0],
        leftFoot: [-0.2 * Math.max(0, c) * mw, 0, 0],
        rightFoot: [-0.2 * Math.max(0, -c) * mw, 0, 0],
      },
    };
    if (this.airWeight < 0.001) return ground;

    const air: RigPose = {
      hipsOffsetY: 0,
      bones: {
        ...ground.bones,
        spine: [0.1, 0, 0],
        leftUpperArm: [-0.3, 0, -0.55],
        rightUpperArm: [-0.3, 0, 0.55],
        leftLowerArm: [0, -0.5, 0],
        rightLowerArm: [0, 0.5, 0],
        leftUpperLeg: [-0.6, 0, 0],
        rightUpperLeg: [-0.25, 0, 0],
        leftLowerLeg: [1.0, 0, 0],
        rightLowerLeg: [0.6, 0, 0],
      },
    };
    return blend(ground, air, this.airWeight);
  }
}

function blend(a: RigPose, b: RigPose, t: number): RigPose {
  const bones = {} as RigPose["bones"];
  for (const name of ANIMATED_BONES) {
    const x = a.bones[name];
    const y = b.bones[name];
    bones[name] = [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  }
  return { bones, hipsOffsetY: a.hipsOffsetY + (b.hipsOffsetY - a.hipsOffsetY) * t };
}
