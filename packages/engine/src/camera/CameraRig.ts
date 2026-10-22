import type { Intents } from "../input/intents";
import { clamp, damp, forwardFromYaw, type Vec3 } from "../math";

export type CameraMode = "third" | "first";

export const CAMERA = {
  /** Third-person orbit pivot above the feet (roughly shoulder height). */
  pivotHeight: 1.45,
  eyeHeight: 1.58,
  distance: { min: 1.2, default: 3.2, max: 6 },
  /** Pitch range; positive looks down. */
  thirdPitch: { min: -0.35, max: 1.2 },
  firstPitch: { min: -1.3, max: 1.3 },
  /** Gap kept between the camera and whatever the spring arm hits. */
  wallPadding: 0.2,
} as const;

export interface CameraPose {
  position: Vec3;
  lookAt: Vec3;
}

/** Distance to the first obstacle along a ray, or null if clear. */
export type RayCaster = (origin: Vec3, dir: Vec3, maxDistance: number) => number | null;

/**
 * Third-person orbit camera with a collision-aware spring arm, plus first-person. Pure math:
 * the caller supplies a raycast so this works with any physics backend.
 */
export class CameraRig {
  mode: CameraMode = "third";
  yaw: number;
  pitch = 0.35;
  private targetDistance: number = CAMERA.distance.default;
  private distance: number = CAMERA.distance.default;

  constructor(initialYaw: number) {
    this.yaw = initialYaw;
  }

  applyIntents(intents: Intents) {
    if (intents.toggleCamera) this.mode = this.mode === "third" ? "first" : "third";
    this.yaw += intents.look.yaw;
    const range = this.mode === "third" ? CAMERA.thirdPitch : CAMERA.firstPitch;
    this.pitch = clamp(this.pitch + intents.look.pitch, range.min, range.max);
    this.targetDistance = clamp(
      this.targetDistance + intents.zoom,
      CAMERA.distance.min,
      CAMERA.distance.max,
    );
  }

  compute(feet: Vec3, castRay: RayCaster, dt: number): CameraPose {
    const fwd = forwardFromYaw(this.yaw);
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);

    if (this.mode === "first") {
      const eye: Vec3 = [
        feet[0] + fwd.x * 0.08,
        feet[1] + CAMERA.eyeHeight,
        feet[2] + fwd.z * 0.08,
      ];
      return {
        position: eye,
        lookAt: [eye[0] + fwd.x * cosP, eye[1] - sinP, eye[2] + fwd.z * cosP],
      };
    }

    const pivot: Vec3 = [feet[0], feet[1] + CAMERA.pivotHeight, feet[2]];
    // Camera sits behind the look direction and above it by `pitch`.
    const dir: Vec3 = [-fwd.x * cosP, sinP, -fwd.z * cosP];
    const hit = castRay(pivot, dir, this.targetDistance + CAMERA.wallPadding);
    const allowed = hit === null ? this.targetDistance : Math.max(0.3, hit - CAMERA.wallPadding);
    // Pull in instantly when something is in the way; ease back out when it clears.
    this.distance = allowed < this.distance ? allowed : damp(this.distance, allowed, 4, dt);

    return {
      position: [
        pivot[0] + dir[0] * this.distance,
        pivot[1] + dir[1] * this.distance,
        pivot[2] + dir[2] * this.distance,
      ],
      lookAt: pivot,
    };
  }
}
