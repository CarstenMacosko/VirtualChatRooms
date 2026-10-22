import { describe, expect, it } from "vitest";
import { applyDeadzone, clampLength, moveFromKeys } from "../src/input/intents";
import { forwardFromYaw, rightFromYaw, wrapAngle, yawFromDirection } from "../src/math";

describe("intents", () => {
  it("normalizes diagonal key movement so it isn't faster", () => {
    const m = moveFromKeys({ forward: true, back: false, left: false, right: true });
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(1, 6);
    expect(m.x).toBeGreaterThan(0);
    expect(m.y).toBeGreaterThan(0);
  });

  it("cancels opposing keys", () => {
    expect(moveFromKeys({ forward: true, back: true, left: false, right: false })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("keeps short vectors and shortens long ones", () => {
    expect(clampLength(0.3, 0.4)).toEqual({ x: 0.3, y: 0.4 });
    const long = clampLength(3, 4);
    expect(long.x).toBeCloseTo(0.6);
    expect(long.y).toBeCloseTo(0.8);
  });

  it("applies a radial deadzone and rescales the rest", () => {
    expect(applyDeadzone(0.1, 0.05)).toEqual({ x: 0, y: 0 });
    const full = applyDeadzone(1, 0);
    expect(full.x).toBeCloseTo(1);
    const mid = applyDeadzone(0.575, 0);
    expect(mid.x).toBeCloseTo(0.5);
  });
});

describe("heading convention", () => {
  it("yaw 0 faces +Z and right is -X", () => {
    expect(forwardFromYaw(0)).toEqual({ x: 0, z: 1 });
    expect(rightFromYaw(0).x).toBeCloseTo(-1);
  });

  it("yawFromDirection inverts forwardFromYaw", () => {
    for (const yaw of [0, 0.5, -2, 3]) {
      const f = forwardFromYaw(yaw);
      expect(wrapAngle(yawFromDirection(f.x, f.z) - yaw)).toBeCloseTo(0);
    }
  });
});
