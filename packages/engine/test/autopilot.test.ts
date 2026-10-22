import { describe, expect, it } from "vitest";
import { ARRIVE_DISTANCE, autopilotStep } from "../src/locomotion/autopilot";

describe("autopilotStep", () => {
  it("heads straight for the target at full speed when far", () => {
    const step = autopilotStep({ x: 0, z: 0 }, { x: 0, z: 3 });
    expect(step.arrived).toBe(false);
    expect(step.move.x).toBeCloseTo(0);
    expect(step.move.z).toBeCloseTo(1);
    expect(step.run).toBe(false);
    expect(step.faceYaw).toBeCloseTo(0); // yaw 0 faces +Z
  });

  it("runs across the room and slows near the end", () => {
    expect(autopilotStep({ x: 0, z: 0 }, { x: 8, z: 0 }).run).toBe(true);
    const near = autopilotStep({ x: 0, z: 0 }, { x: ARRIVE_DISTANCE + 0.1, z: 0 });
    expect(Math.hypot(near.move.x, near.move.z)).toBeLessThan(1);
    expect(near.move.x).toBeGreaterThan(0);
  });

  it("stops at conversation distance, facing them", () => {
    const step = autopilotStep({ x: 0, z: 0 }, { x: -1, z: 0 });
    expect(step.arrived).toBe(true);
    expect(step.move).toEqual({ x: 0, z: 0 });
    expect(step.faceYaw).toBeCloseTo(-Math.PI / 2);
  });
});
