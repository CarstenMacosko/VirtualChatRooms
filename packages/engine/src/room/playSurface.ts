import type { Table } from "@vcr/protocol";
import type { Vec3 } from "../math";

/**
 * Space the scan is kept out of, so what we draw into the room isn't poked through by it. A scan
 * is never quite where the room setup says: a photogrammetry tabletop is bumpy by a centimeter or
 * two, and a splat's surface is fuzzy. The room renderers hide every surface and splat inside
 * `roomClearances`, so a new feature that needs space clears it by adding its boxes there.
 */

/** An oriented box: its center, yaw about +Y, and half extents. */
export interface Clearance {
  center: Vec3;
  yaw: number;
  half: Vec3;
}

/** A play surface's top is this far above the recorded tabletop… */
export const SURFACE_LIFT = 0.012;
/** …and its slab reaches this far below it, past the bumps of a scanned top. */
export const SURFACE_SINK = 0.04;
/** Kept clear above a play surface: pieces held up, and the scan's clutter (a vase, a remote). */
export const SURFACE_HEADROOM = 0.45;
/** A play surface overhangs the recorded table by this much on every side. */
const SURFACE_MARGIN = 0.015;

/**
 * A smooth slab laid over a table with games. The scan is hidden inside it and in the headroom
 * above, and games draw on its top, so the scan's own tabletop can never show through a game.
 */
export interface PlaySurface {
  id: string;
  /** The middle of the slab's top face (world space): where games draw. */
  center: Vec3;
  yaw: number;
  /** [width, depth] along the table's local X and Z, in meters. */
  size: [number, number];
  /** Down from `center` to the slab's underside. */
  thickness: number;
}

/** The play surface over a table (whether or not it has games). */
export function playSurface(table: Table): PlaySurface {
  const [x, y, z] = table.center;
  return {
    id: table.id,
    center: [x, y + SURFACE_LIFT, z],
    yaw: table.yaw,
    size: [table.size[0] + 2 * SURFACE_MARGIN, table.size[1] + 2 * SURFACE_MARGIN],
    thickness: SURFACE_LIFT + SURFACE_SINK,
  };
}

/** A play surface over every table with a game on it. */
export function playSurfaces(tables: readonly Table[]): PlaySurface[] {
  return tables.filter((t) => t.games.length > 0).map(playSurface);
}

/**
 * The box hidden for a play surface: the slab itself, which stands in for the scan there (so its
 * edge shows the slab's side, not a hole), and the headroom above it.
 */
export function surfaceClearance(s: PlaySurface): Clearance {
  const bottom = s.center[1] - s.thickness;
  const top = s.center[1] + SURFACE_HEADROOM;
  return {
    center: [s.center[0], (bottom + top) / 2, s.center[2]],
    yaw: s.yaw,
    half: [s.size[0] / 2, (top - bottom) / 2, s.size[1] / 2],
  };
}

/** Every box the room renderers hide the scan in. */
export function roomClearances(room: { tables: readonly Table[] }): Clearance[] {
  return playSurfaces(room.tables).map(surfaceClearance);
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
