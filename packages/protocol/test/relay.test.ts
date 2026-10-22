import { describe, expect, it } from "vitest";
import { decodePose, encodePose, LocoState } from "../src/pose";
import { decodeRelayedPose, encodeRelayedPose, MAX_POSE_BYTES } from "../src/relay";

describe("relayed pose envelope", () => {
  it("round-trips the sender id and pose", () => {
    const pose = encodePose({
      seq: 9,
      t: 1234,
      position: [1, 0, 2],
      yaw: 0.5,
      loco: LocoState.run,
    });
    const relayed = decodeRelayedPose(encodeRelayedPose("Ab3_xY9", pose));
    expect(relayed.from).toBe("Ab3_xY9");
    expect(decodePose(relayed.pose).seq).toBe(9);
  });

  it("rejects truncated envelopes", () => {
    expect(() => decodeRelayedPose(new Uint8Array([20, 1, 2]))).toThrow(RangeError);
    expect(() => decodeRelayedPose(new Uint8Array([]))).toThrow(RangeError);
  });

  it("fits the largest possible pose within the relay limit", () => {
    const full = encodePose({
      seq: 1,
      t: 1,
      position: [0, 0, 0],
      yaw: 0,
      loco: LocoState.idle,
      seatId: 1,
      head: [0, 0, 0, 1],
      handL: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      handR: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      face: new Uint8Array(52),
    });
    expect(full.byteLength).toBeLessThanOrEqual(MAX_POSE_BYTES);
  });
});
