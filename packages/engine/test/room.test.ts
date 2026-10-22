import { describe, expect, it } from "vitest";
import { LocoState } from "@vcr/protocol";
import { ProceduralAnimator } from "../src/avatar/ProceduralAnimator";
import { detectDeviceProfile } from "../src/device/deviceProfile";
import { buildSampleRoomSplats, sampleRoomColliders, SAMPLE_ROOM } from "../src/room/sampleRoom";

describe("sample room", () => {
  it("is identical on every client", () => {
    const collect = () => {
      const out: number[] = [];
      buildSampleRoomSplats(0.08, (c, s, q, o, col) => out.push(...c, ...s, ...q, o, ...col));
      return out;
    };
    expect(collect()).toEqual(collect());
  });

  it("stays within splat budgets for both device tiers", () => {
    const high = buildSampleRoomSplats(0.035, () => {});
    const low = buildSampleRoomSplats(0.06, () => {});
    expect(high).toBeLessThan(1_500_000);
    expect(low).toBeLessThan(400_000);
    expect(low).toBeLessThan(high);
  });

  it("keeps every splat inside the room and emits valid colors", () => {
    const { min, max } = SAMPLE_ROOM.bounds;
    buildSampleRoomSplats(0.1, (c, _s, _q, o, col) => {
      c.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(min[i]! - 0.01);
        expect(v).toBeLessThanOrEqual(max[i]! + 0.01);
      });
      expect(o).toBeGreaterThan(0);
      col.forEach((v) => expect(Number.isFinite(v)).toBe(true));
    });
  });

  it("has colliders for floor, walls and furniture but not the rug", () => {
    const colliders = sampleRoomColliders();
    expect(colliders.length).toBeGreaterThan(10);
    expect(colliders.some((c) => c.halfExtents[1] < 0.01)).toBe(false);
  });
});

describe("device profile", () => {
  const desktop = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15",
    coarsePointer: false,
    hardwareConcurrency: 10,
    devicePixelRatio: 2,
  };

  it("uses high quality on a capable desktop", () => {
    const p = detectDeviceProfile(desktop);
    expect(p.tier).toBe("high");
    expect(p.touch).toBe(false);
  });

  it("uses low quality and touch controls on phones", () => {
    const p = detectDeviceProfile({
      ...desktop,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile",
      coarsePointer: true,
      devicePixelRatio: 3,
    });
    expect(p).toMatchObject({ tier: "low", touch: true, maxDpr: 1.5 });
  });

  it("respects the ?quality override", () => {
    expect(detectDeviceProfile({ ...desktop, override: "low" }).tier).toBe("low");
  });
});

describe("ProceduralAnimator", () => {
  it("swings legs in opposite directions while walking", () => {
    const anim = new ProceduralAnimator();
    let maxDiff = 0;
    for (let i = 0; i < 120; i++) {
      const pose = anim.update(1 / 60, { loco: LocoState.walk, speed: 1.7 });
      maxDiff = Math.max(
        maxDiff,
        Math.abs(pose.bones.leftUpperLeg[0] - pose.bones.rightUpperLeg[0]),
      );
      expect(Math.sign(pose.bones.leftUpperLeg[0])).not.toBe(
        Math.sign(pose.bones.rightUpperLeg[0]) || 2,
      );
    }
    expect(maxDiff).toBeGreaterThan(0.5);
  });

  it("settles to a still pose when idle", () => {
    const anim = new ProceduralAnimator();
    let pose = anim.update(1 / 60, { loco: LocoState.idle, speed: 0 });
    for (let i = 0; i < 120; i++) pose = anim.update(1 / 60, { loco: LocoState.idle, speed: 0 });
    expect(Math.abs(pose.bones.leftUpperLeg[0])).toBeLessThan(0.01);
    expect(pose.bones.leftUpperArm[2]).toBeLessThan(-1); // arms hang down
  });
});
