import { describe, expect, it } from "vitest";
import {
  type AvatarPose,
  decodePose,
  encodePose,
  isNewerSeq,
  LocoState,
  PoseDecodeError,
  POSE_WIRE_VERSION,
} from "../src/pose";

const basePose: AvatarPose = {
  seq: 42,
  t: 123_456,
  position: [1.23, 0, -4.56],
  yaw: 1.5,
  loco: LocoState.walk,
};

describe("pose codec", () => {
  it("round-trips the required fields within quantization error", () => {
    const decoded = decodePose(encodePose(basePose));
    expect(decoded.seq).toBe(42);
    expect(decoded.t).toBe(123_456);
    expect(decoded.loco).toBe(LocoState.walk);
    decoded.position.forEach((c, i) => expect(c).toBeCloseTo(basePose.position[i]!, 2));
    expect(decoded.yaw).toBeCloseTo(1.5, 3);
    expect(decoded.head).toBeUndefined();
    expect(decoded.face).toBeUndefined();
  });

  it("keeps the base packet small", () => {
    expect(encodePose(basePose).byteLength).toBe(17);
  });

  it("round-trips every optional field (sitting, VR head and hands, face)", () => {
    const face = Uint8Array.from({ length: 52 }, (_, i) => i * 4);
    const pose: AvatarPose = {
      ...basePose,
      loco: LocoState.seated,
      seatId: 7,
      head: [0, 0.7071, 0, 0.7071],
      handL: { position: [-0.3, 1.1, 0.2], rotation: [0, 0, 0, 1] },
      handR: { position: [0.3, 1.1, 0.2], rotation: [0.5, 0.5, 0.5, 0.5] },
      face,
    };
    const decoded = decodePose(encodePose(pose));
    expect(decoded.seatId).toBe(7);
    decoded.head!.forEach((c, i) => expect(c).toBeCloseTo(pose.head![i]!, 3));
    decoded.handL!.position.forEach((c, i) => expect(c).toBeCloseTo(pose.handL!.position[i]!, 2));
    decoded.handR!.rotation.forEach((c, i) => expect(c).toBeCloseTo(pose.handR!.rotation[i]!, 3));
    expect(Array.from(decoded.face!)).toEqual(Array.from(face));
  });

  it("canonicalizes quaternions so q and -q encode identically", () => {
    const a = encodePose({ ...basePose, head: [0, 0.6, 0, 0.8] });
    const b = encodePose({ ...basePose, head: [0, -0.6, 0, -0.8] });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("wraps yaw into (-π, π]", () => {
    const decoded = decodePose(encodePose({ ...basePose, yaw: Math.PI * 3 + 0.25 }));
    expect(decoded.yaw).toBeCloseTo(-Math.PI + 0.25, 3);
  });

  it("clamps positions outside the ±327 m range instead of overflowing", () => {
    const decoded = decodePose(encodePose({ ...basePose, position: [1000, -1000, 0] }));
    expect(decoded.position[0]).toBeCloseTo(327.67, 2);
    expect(decoded.position[1]).toBeCloseTo(-327.67, 2);
  });

  it("ignores trailing bytes from fields added by newer senders", () => {
    const bytes = encodePose(basePose);
    const extended = new Uint8Array(bytes.byteLength + 5);
    extended.set(bytes);
    extended[1] = extended[1]! | (1 << 7); // a flag bit this decoder doesn't know
    expect(decodePose(extended).seq).toBe(42);
  });

  it("decodes from a view into a larger buffer", () => {
    const bytes = encodePose(basePose);
    const big = new Uint8Array(bytes.byteLength + 10);
    big.set(bytes, 10);
    expect(decodePose(big.subarray(10)).t).toBe(123_456);
  });

  it("rejects truncated packets and unknown wire versions", () => {
    const bytes = encodePose({ ...basePose, head: [0, 0, 0, 1] });
    expect(() => decodePose(bytes.slice(0, 10))).toThrow(PoseDecodeError);
    expect(() => decodePose(bytes.slice(0, bytes.byteLength - 1))).toThrow(PoseDecodeError);
    const wrongVersion = bytes.slice();
    wrongVersion[0] = POSE_WIRE_VERSION + 1;
    expect(() => decodePose(wrongVersion)).toThrow(/wire version/);
  });

  it("wraps seq at 65536", () => {
    expect(decodePose(encodePose({ ...basePose, seq: 65_537 })).seq).toBe(1);
  });
});

describe("isNewerSeq", () => {
  it("handles normal ordering and wraparound", () => {
    expect(isNewerSeq(5, 4)).toBe(true);
    expect(isNewerSeq(4, 5)).toBe(false);
    expect(isNewerSeq(4, 4)).toBe(false);
    expect(isNewerSeq(2, 65_530)).toBe(true);
    expect(isNewerSeq(65_530, 2)).toBe(false);
  });
});
