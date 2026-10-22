import { yawFromDirection } from "../math";

/** How close "walk over to someone" stops: conversation distance, not bumping into them. */
export const ARRIVE_DISTANCE = 1.3;
/** Farther than this, the autopilot runs instead of walking. */
const RUN_DISTANCE = 5;

export interface AutopilotStep {
  /** World-space move direction (length ≤ 1), as the character controller takes it. */
  move: { x: number; z: number };
  run: boolean;
  arrived: boolean;
  /** Which way to face once arrived: toward the target. */
  faceYaw: number;
}

/**
 * One frame of "walk over to that person" (double-clicking a video tile). Steers straight at the
 * target and eases off over the last half metre so the character doesn't overshoot. Obstacles are
 * left to the character controller's sliding; rooms are small and mostly open.
 */
export function autopilotStep(
  from: { x: number; z: number },
  to: { x: number; z: number },
  arriveDistance = ARRIVE_DISTANCE,
): AutopilotStep {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  const faceYaw = yawFromDirection(dx, dz);
  if (dist <= arriveDistance) return { move: { x: 0, z: 0 }, run: false, arrived: true, faceYaw };
  const ease = Math.min(1, (dist - arriveDistance) / 0.5 + 0.3);
  return {
    move: { x: (dx / dist) * ease, z: (dz / dist) * ease },
    run: dist > RUN_DISTANCE,
    arrived: false,
    faceYaw,
  };
}
