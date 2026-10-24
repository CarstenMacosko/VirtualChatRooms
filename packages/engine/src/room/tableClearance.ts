import type { Table } from "@vcr/protocol";
import type { Vec3 } from "../math";

/**
 * Above a game table the scan's own clutter (a vase, a remote, the bumps of a cloth) would poke
 * through the puzzle, so the room renderer hides it inside this box: from just over the table's
 * top to `CLEARANCE_HEIGHT` above, a little wider than the table.
 */
export const CLEARANCE_HEIGHT = 0.45;
/** Kept between the table top and the cleared box, so the top itself still shows. */
const ABOVE_TOP = 0.015;
const MARGIN = 0.03;

/** An oriented box: its center, yaw about +Y, and half extents. */
export interface Clearance {
  center: Vec3;
  yaw: number;
  half: Vec3;
}

/** The cleared box over every table with a game on it. */
export function tableClearances(tables: readonly Table[]): Clearance[] {
  return tables
    .filter((t) => t.games.length > 0)
    .map((t) => ({
      center: [t.center[0], t.center[1] + ABOVE_TOP + CLEARANCE_HEIGHT / 2, t.center[2]],
      yaw: t.yaw,
      half: [t.size[0] / 2 + MARGIN, CLEARANCE_HEIGHT / 2, t.size[1] / 2 + MARGIN],
    }));
}

/** Whether a world point is inside a clearance (for tests and anything not on the GPU). */
export function inClearance(p: Vec3, c: Clearance): boolean {
  const dx = p[0] - c.center[0];
  const dz = p[2] - c.center[2];
  const cos = Math.cos(c.yaw);
  const sin = Math.sin(c.yaw);
  // Into the box's frame: rotate by −yaw about +Y.
  const lx = cos * dx - sin * dz;
  const lz = sin * dx + cos * dz;
  return (
    Math.abs(lx) <= c.half[0] &&
    Math.abs(p[1] - c.center[1]) <= c.half[1] &&
    Math.abs(lz) <= c.half[2]
  );
}
