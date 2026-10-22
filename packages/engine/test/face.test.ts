import { describe, expect, it } from "vitest";
import { ARKIT_BLENDSHAPES, ARKIT_INDEX, LocoState } from "@vcr/protocol";
import { EMOTE_DURATION_S } from "../src/avatar/emotes";
import { ProceduralAnimator } from "../src/avatar/ProceduralAnimator";
import { arkitToVrm } from "../src/face/expressions";
import { FaceAnimator } from "../src/face/FaceAnimator";

const run = (face: FaceAnimator, seconds: number, input = {}) => {
  let w = face.update(0, input);
  for (let t = 0; t < seconds; t += 1 / 60) w = face.update(1 / 60, input);
  return w;
};

describe("FaceAnimator", () => {
  it("blinks on its own every few seconds", () => {
    const face = new FaceAnimator(() => 0.5);
    let peak = 0;
    for (let t = 0; t < 7; t += 1 / 60) peak = Math.max(peak, face.update(1 / 60, {}).blinkLeft);
    expect(peak).toBeGreaterThan(0.9);
  });

  it("opens the mouth with the voice and closes it in silence", () => {
    const face = new FaceAnimator(() => 0.99);
    expect(run(face, 0.5, { voice: 0.4 }).aa).toBeGreaterThan(0.3);
    expect(run(face, 0.5, { voice: 0 }).aa).toBeLessThan(0.05);
  });

  it("mirrors tracked blendshapes", () => {
    const tracked = new Uint8Array(ARKIT_BLENDSHAPES.length);
    tracked[ARKIT_INDEX.mouthSmileLeft] = 230;
    tracked[ARKIT_INDEX.mouthSmileRight] = 230;
    tracked[ARKIT_INDEX.eyeBlinkLeft] = 255;
    expect(arkitToVrm(tracked).happy).toBeGreaterThan(0.9);
    const w = run(new FaceAnimator(), 0.5, { tracked });
    expect(w.happy).toBeGreaterThan(0.9);
    expect(w.blinkLeft).toBe(1);
    expect(w.blinkRight).toBe(0);
  });

  it("layers an emote's mood on top", () => {
    expect(run(new FaceAnimator(), 0.5, { mood: { happy: 1 } }).happy).toBeGreaterThan(0.95);
  });
});

describe("emotes", () => {
  it("raises an arm to wave, then returns to idle", () => {
    const animator = new ProceduralAnimator();
    const idle = { loco: LocoState.idle, speed: 0 };
    const rest = animator.update(1 / 60, idle).bones.rightUpperArm[2];
    animator.playEmote("wave");
    let pose = animator.update(0.6, idle);
    expect(pose.bones.rightUpperArm[2]).toBeLessThan(rest - 1); // raised, not hanging
    expect(pose.mood?.happy).toBeGreaterThan(0.5);
    pose = animator.update(EMOTE_DURATION_S, idle);
    expect(pose.bones.rightUpperArm[2]).toBeCloseTo(rest, 1);
    expect(pose.mood).toBeUndefined();
  });

  it("adds head look on top of the animation", () => {
    const animator = new ProceduralAnimator();
    const pose = animator.update(1 / 60, {
      loco: LocoState.idle,
      speed: 0,
      headLook: { pitch: 0, yaw: 0.4, roll: 0 },
    });
    expect(pose.bones.head[1]).toBeCloseTo(0.4);
  });
});
