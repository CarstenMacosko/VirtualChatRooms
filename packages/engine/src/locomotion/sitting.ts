import type { Seat } from "@vcr/protocol";
import { type CameraBody, STANDING_BODY } from "../camera/CameraRig";
import { clamp, forwardFromYaw, lerp, type Vec3, wrapAngle } from "../math";

/**
 * Sitting (ADR 0020): which seat you can sit on from where you stand, and where you end up on the
 * way down and back up. Seats come from the room layout (the manifest, or the sample room).
 *
 * While seated the character's feet point is the floor right under the hips (the seat's
 * position, dropped by its height); the animator lowers the hips onto the seat and puts the feet
 * forward.
 */

export const SITTING = {
  /** How close (feet to seat, meters) a seat has to be to offer it. */
  reach: 1.3,
  /** How far off your heading (radians) a seat can be and still count as in front of you. */
  facing: (100 * Math.PI) / 180,
  /** Where you stand before lowering yourself: this far in front of the seat. */
  approach: 0.45,
  /** Glide speed to the approach point, m/s; the glide never takes longer than `maxGlide`. */
  glideSpeed: 1.6,
  maxGlide: 0.8,
  /** Lowering onto the seat, and getting up again, seconds. */
  sitTime: 0.5,
  standTime: 0.5,
  /** Where getting up ends: in front of the seat, tried nearest first. */
  standDistances: [0.55, 0.7, 0.85],
  standOffsets: [0, 0.3, -0.3, 0.55, -0.55],
} as const;

/**
 * The camera's hang-off point while sitting `amount` (0–1) of the way onto a seat `seatHeight`
 * up: eyes and orbit pivot at seated height, the orbit a little closer.
 */
export function seatedCameraBody(seatHeight: number, amount: number): CameraBody {
  const t = clamp(amount, 0, 1);
  return {
    eyeHeight: lerp(STANDING_BODY.eyeHeight, seatHeight + 0.72, t),
    pivotHeight: lerp(STANDING_BODY.pivotHeight, seatHeight + 0.62, t),
    distanceScale: lerp(1, 0.85, t),
  };
}

/** A seat to sit on (Seat's shape, minus what the controller doesn't need). */
export type SeatTarget = Pick<Seat, "id" | "position" | "yaw" | "height" | "kind">;

/** The floor under the hips: the character's feet point while seated. */
export function seatFloorPoint(seat: SeatTarget): Vec3 {
  return [seat.position[0], seat.position[1] - seat.height, seat.position[2]];
}

/** A point on the floor `distance` in front of the seat, `offset` to the sitter's left. */
export function inFrontOfSeat(seat: SeatTarget, distance: number, offset = 0): Vec3 {
  const f = forwardFromYaw(seat.yaw);
  const [x, y, z] = seatFloorPoint(seat);
  // Left of someone facing +Z is +X (yaw grows to the left).
  return [x + f.x * distance + f.z * offset, y, z + f.z * distance - f.x * offset];
}

/**
 * The seat to offer someone standing at `feet` facing `yaw`: the nearest free one within reach
 * that's roughly in front of them (or that they're already standing in front of). Seats in
 * `taken` are someone else's.
 */
export function pickSeat<S extends SeatTarget>(
  seats: readonly S[],
  feet: Vec3,
  yaw: number,
  taken: ReadonlySet<number> = new Set(),
): S | null {
  let best: S | null = null;
  let bestDistance = Infinity;
  for (const seat of seats) {
    if (taken.has(seat.id)) continue;
    // Distance to the seat's front edge area, where you'd stand to sit down.
    const front = inFrontOfSeat(seat, 0.2);
    const dx = front[0] - feet[0];
    const dz = front[2] - feet[2];
    const distance = Math.hypot(dx, dz);
    if (distance > SITTING.reach || Math.abs(feet[1] - front[1]) > 0.6) continue;
    const toSeat = Math.atan2(dx, dz);
    const inFront = distance < 0.35 || Math.abs(wrapAngle(toSeat - yaw)) <= SITTING.facing;
    if (inFront && distance < bestDistance) [best, bestDistance] = [seat, distance];
  }
  return best;
}

/**
 * Where to stand up to: the first spot in front of the seat that `fits` (open floor the capsule
 * can stand on), else `fallback` (where you sat down from).
 */
export function standSpot(seat: SeatTarget, fits: (feet: Vec3) => boolean, fallback: Vec3): Vec3 {
  for (const distance of SITTING.standDistances) {
    for (const offset of SITTING.standOffsets) {
      const spot = inFrontOfSeat(seat, distance, offset);
      if (fits(spot)) return spot;
    }
  }
  return fallback;
}
