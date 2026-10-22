export type Vec3 = [number, number, number];

/** Wraps an angle into (-π, π]. */
export function wrapAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  let a = ((((rad + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  if (a === -Math.PI) a = Math.PI;
  return a;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolates along the shorter way around the circle. */
export const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Frame-rate independent exponential smoothing: higher `lambda` converges faster. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return lerpAngle(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Character/camera heading convention used everywhere in the engine: yaw 0 faces +Z (the way
 * VRM 1.0 avatars face), and increasing yaw turns left when seen from above.
 */
export function forwardFromYaw(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

export function rightFromYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.cos(yaw), z: Math.sin(yaw) };
}

export const yawFromDirection = (x: number, z: number) => Math.atan2(x, z);

/** Small deterministic PRNG so every client builds identical procedural content. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
