import type { Walkway } from "@vcr/protocol";
import type { Vec3 } from "../math";
import type { BoxCollider } from "../locomotion/physics";
import { CHARACTER } from "../locomotion/CharacterController";

/**
 * Walkways (room setup): floor rectangles the owner keeps walkable through scan clutter. Inside
 * one, collision above `WALKWAY_CUT_HEIGHT` is removed and the floor stays. Applied when the room's
 * colliders are built, so a change takes effect when people (re)join.
 */

/** World-space axis-aligned box. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Collision at or below this height (meters above the floor at y = 0) is kept. */
export const WALKWAY_CUT_HEIGHT = 0.05;
/** Pieces thinner than this along any axis are dropped. */
const MIN_THICKNESS = 0.001;

export const aabbToCollider = ({ min, max }: Aabb): BoxCollider => ({
  center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
});

const solid = ({ min, max }: Aabb) =>
  max[0] - min[0] >= MIN_THICKNESS &&
  max[1] - min[1] >= MIN_THICKNESS &&
  max[2] - min[2] >= MIN_THICKNESS;

/**
 * `box` minus one walkway's prism (its rectangle × y ≥ `cut`): the part below the cut, plus up
 * to four pieces around the rectangle above it.
 */
function subtract(box: Aabb, w: Walkway, cut: number): Aabb[] {
  const { min, max } = box;
  const [wx0, wz0] = w.min;
  const [wx1, wz1] = w.max;
  if (max[1] <= cut || max[0] <= wx0 || min[0] >= wx1 || max[2] <= wz0 || min[2] >= wz1) {
    return [box];
  }
  const pieces: Aabb[] = [];
  if (min[1] < cut) pieces.push({ min, max: [max[0], cut, max[2]] });
  const y0 = Math.max(min[1], cut);
  const y1 = max[1];
  if (min[0] < wx0) pieces.push({ min: [min[0], y0, min[2]], max: [wx0, y1, max[2]] });
  if (max[0] > wx1) pieces.push({ min: [wx1, y0, min[2]], max: [max[0], y1, max[2]] });
  const x0 = Math.max(min[0], wx0);
  const x1 = Math.min(max[0], wx1);
  if (min[2] < wz0) pieces.push({ min: [x0, y0, min[2]], max: [x1, y1, wz0] });
  if (max[2] > wz1) pieces.push({ min: [x0, y0, wz1], max: [x1, y1, max[2]] });
  return pieces.filter(solid);
}

/** The boxes with every walkway's prism cut out. */
export function clipToWalkways(
  boxes: readonly Aabb[],
  walkways: readonly Walkway[],
  cut = WALKWAY_CUT_HEIGHT,
): Aabb[] {
  let out = boxes.filter(solid);
  for (const w of walkways) out = out.flatMap((b) => subtract(b, w, cut));
  return out;
}

/**
 * Walkways widened by the character's radius (plus a hair): with those cut out, nothing touches
 * a capsule whose center is inside the walkway, so you pass through freely however tight the gap
 * is, your body overlapping the furniture beside it.
 */
export function passableWalkways(walkways: readonly Walkway[]): Walkway[] {
  const r = CHARACTER.radius + 0.02;
  return walkways.map((w) => ({
    ...w,
    min: [w.min[0] - r, w.min[1] - r],
    max: [w.max[0] + r, w.max[1] + r],
  }));
}

/** Whether a world point is inside a walkway's prism (above the cut). */
export function inWalkway(
  x: number,
  y: number,
  z: number,
  walkways: readonly Walkway[],
  cut = WALKWAY_CUT_HEIGHT,
): boolean {
  return (
    y > cut && walkways.some((w) => x > w.min[0] && x < w.max[0] && z > w.min[1] && z < w.max[1])
  );
}

/**
 * For collision meshes that aren't boxes: the triangles that don't reach into any walkway's prism.
 * A triangle that only touches a corner of it still goes, so nothing in the walkway can catch you.
 * `vertices` are world space, xyz interleaved.
 */
export function dropWalkwayTriangles(
  vertices: Float32Array,
  indices: Uint32Array,
  walkways: readonly Walkway[],
  cut = WALKWAY_CUT_HEIGHT,
): Uint32Array {
  if (!walkways.length) return indices;
  const kept: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const x0 = Math.min(vertices[a]!, vertices[b]!, vertices[c]!);
    const x1 = Math.max(vertices[a]!, vertices[b]!, vertices[c]!);
    const y1 = Math.max(vertices[a + 1]!, vertices[b + 1]!, vertices[c + 1]!);
    const z0 = Math.min(vertices[a + 2]!, vertices[b + 2]!, vertices[c + 2]!);
    const z1 = Math.max(vertices[a + 2]!, vertices[b + 2]!, vertices[c + 2]!);
    const reaches =
      y1 > cut &&
      walkways.some((w) => x1 > w.min[0] && x0 < w.max[0] && z1 > w.min[1] && z0 < w.max[1]);
    if (!reaches) kept.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
  }
  return Uint32Array.from(kept);
}

/**
 * Post-processing writes the collision mesh as boxes: 8 vertices each (corner bit 4 = +x,
 * 2 = +y, 1 = +z) and 36 indices, axis-aligned in the world. Returns their world AABBs, or null
 * when the mesh isn't made that way (`vertices` world space, xyz interleaved).
 */
export function collisionBoxes(vertices: Float32Array, indices: Uint32Array): Aabb[] | null {
  const count = vertices.length / 24;
  if (!Number.isInteger(count) || count === 0 || indices.length !== count * 36) return null;
  const boxes: Aabb[] = [];
  for (let n = 0; n < count; n++) {
    for (let k = n * 36; k < n * 36 + 36; k++) {
      const i = indices[k]!;
      if (i < n * 8 || i >= n * 8 + 8) return null;
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let v = n * 24; v < n * 24 + 24; v += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, vertices[v + a]!);
        max[a] = Math.max(max[a]!, vertices[v + a]!);
      }
    }
    // Axis-aligned in the world: every corner lies at one end of the box along each axis. (The
    // corner bits are file-space axes, which the transform may have rotated, so any end will do.)
    const eps = 1e-4 + 1e-5 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    for (let v = n * 24; v < n * 24 + 24; v += 3) {
      for (let a = 0; a < 3; a++) {
        const p = vertices[v + a]!;
        if (Math.abs(p - min[a]!) > eps && Math.abs(p - max[a]!) > eps) return null;
      }
    }
    boxes.push({ min, max });
  }
  return boxes;
}
