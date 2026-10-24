import { type EmoteId, LocoState } from "@vcr/protocol";
import type { ExpressionWeights } from "../face/expressions";
import { clamp, damp } from "../math";
import { EMOTE_DURATION_S, emoteEnvelope, emoteFrame } from "./emotes";

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
  /** Expressions the current emote wants on the face. */
  mood?: Partial<ExpressionWeights>;
}

export interface AnimatorInput {
  loco: LocoState;
  speed: number;
  /** First-person look pitch, radians. */
  lookPitch?: number;
  /** Extra head rotation (face tracking, or turning toward whoever's talking), radians. */
  headLook?: { pitch: number; yaw: number; roll: number };
  /**
   * Sitting (loco sitDown or seated): the seat surface's height above the feet point, which is
   * the floor under the hips. Defaults to a chair's.
   */
  seatHeight?: number;
  /** Standing hips height above the feet (the avatar's rest pose), meters. */
  hipsHeight?: number;
}

const ARM_DOWN = 1.25;
/** Meters travelled per full gait cycle (two steps). */
const STRIDE = 1.4;
const DEFAULT_SEAT_HEIGHT = 0.45;
const DEFAULT_HIPS_HEIGHT = 0.92;
/** Seats lower than this (cushions on the floor) get crossed legs. */
const FLOOR_SEAT = 0.25;

const isSeated = (loco: LocoState) => loco === LocoState.sitDown || loco === LocoState.seated;
const isSitting = (loco: LocoState) => isSeated(loco) || loco === LocoState.standUp;

/**
 * Placeholder animation computed from locomotion state and speed: idle breathing, a walk/run
 * cycle, an airborne pose and sitting (lowering onto a seat and getting up), blended smoothly. Phase 3 replaces it with a clip library; the
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
  private sitWeight = 0;
  private emote: { id: EmoteId; startedAt: number } | null = null;

  /** Plays an emote over whatever the avatar is doing; a new one replaces the last. */
  playEmote(id: EmoteId) {
    this.emote = { id, startedAt: this.time };
  }

  update(dt: number, input: AnimatorInput): RigPose {
    const pose = this.locomotion(dt, input);
    const look = input.headLook;
    if (look) {
      const h = pose.bones.head;
      pose.bones.head = [h[0] + look.pitch, h[1] + look.yaw, h[2] + look.roll];
    }
    if (!this.emote) return pose;
    const t = this.time - this.emote.startedAt;
    if (t > EMOTE_DURATION_S) {
      this.emote = null;
      return pose;
    }
    const frame = emoteFrame(this.emote.id, t);
    // Moving cancels the arm-heavy parts of an emote only halfway, so waving while walking works.
    const weight = emoteEnvelope(t) * (1 - 0.5 * this.moveWeight);
    const bones = { ...pose.bones };
    for (const [name, rot] of Object.entries(frame.bones) as [
      AnimatedBone,
      [number, number, number],
    ][]) {
      const from = bones[name];
      bones[name] = [
        from[0] + (rot[0] - from[0]) * weight,
        from[1] + (rot[1] - from[1]) * weight,
        from[2] + (rot[2] - from[2]) * weight,
      ];
    }
    const mood = Object.fromEntries(
      Object.entries(frame.face).map(([k, v]) => [k, (v ?? 0) * emoteEnvelope(t)]),
    ) as Partial<ExpressionWeights>;
    return {
      bones,
      hipsOffsetY: pose.hipsOffsetY + (frame.hipsOffsetY ?? 0) * weight,
      mood,
    };
  }

  private locomotion(dt: number, input: AnimatorInput): RigPose {
    this.time += dt;
    const airborne = input.loco === LocoState.jump || input.loco === LocoState.fall;
    // Gliding onto or off a seat isn't walking.
    const speed = airborne || isSitting(input.loco) ? 0 : input.speed;
    // About half a second either way, like the controller's sit and stand moves.
    this.sitWeight = damp(this.sitWeight, isSeated(input.loco) ? 1 : 0, 9, dt);
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
    const sitting =
      this.sitWeight > 0.001 ? blend(ground, this.seated(input, breathe), this.sitWeight) : ground;
    if (this.airWeight < 0.001) return sitting;

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
    return blend(sitting, air, this.airWeight);
  }

  /**
   * Sitting: hips on the seat, thighs forward, knees bent ~90° with the feet on the floor, leaning
   * back a little, hands in the lap. On a floor cushion the legs cross instead.
   */
  private seated(input: AnimatorInput, breathe: number): RigPose {
    const seat = input.seatHeight ?? DEFAULT_SEAT_HEIGHT;
    const hips = input.hipsHeight ?? DEFAULT_HIPS_HEIGHT;
    const floor = seat < FLOOR_SEAT;
    // The hip joints sit a little above the seat surface.
    const hipsOffsetY = seat + 0.08 - hips;
    const lean = floor ? 0.05 : -0.1;
    return {
      hipsOffsetY,
      bones: {
        hips: [0, 0, 0],
        spine: [lean, 0, 0],
        chest: [breathe, 0, 0],
        neck: [0, 0, 0],
        head: [(input.lookPitch ?? 0) * 0.6 - lean, 0, 0],
        leftUpperArm: [-0.55, 0, -1.15],
        rightUpperArm: [-0.55, 0, 1.15],
        leftLowerArm: [0, -0.7, 0],
        rightLowerArm: [0, 0.7, 0],
        // Euler XYZ turns about Z first: spread the knees out, then swing the thighs forward.
        leftUpperLeg: floor ? [-1.35, 0, 0.75] : [-1.5, 0, 0.06],
        rightUpperLeg: floor ? [-1.35, 0, -0.75] : [-1.5, 0, -0.06],
        leftLowerLeg: floor ? [2.3, 0, 0] : [1.5, 0, 0],
        rightLowerLeg: floor ? [2.3, 0, 0] : [1.5, 0, 0],
        leftFoot: [0, 0, 0],
        rightFoot: [0, 0, 0],
      },
    };
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
