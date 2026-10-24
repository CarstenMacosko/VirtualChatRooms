import type { Seat, Table, Walkway } from "@vcr/protocol";
import { clamp, type Vec3, wrapAngle } from "../math";

/**
 * Geometry and bookkeeping for the room setup editor (walkways, seats, tables), kept pure so it
 * can be tested without a scene. World space: meters, +Y up, X/Z on the floor.
 */

type XZ = [number, number];

/** A new seat's id: one past the highest (ids stay unique while a gathering runs), else the lowest free one. */
export function nextSeatId(seats: readonly Pick<Seat, "id">[]): number {
  const used = new Set(seats.map((s) => s.id));
  const next = Math.max(0, ...used) + 1;
  if (next <= 0xffff) return next;
  for (let id = 1; id <= 0xffff; id++) if (!used.has(id)) return id;
  throw new Error("No seat ids left.");
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short random id for a table or walkway, unlike any in `taken`. */
export function newSetupId(taken: Iterable<string> = [], length = 8): string {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (!used.has(id)) return id;
  }
}

/** The rectangle two opposite corners span, min below max, kept inside the room's floor. */
export function rectFromCorners(
  a: XZ,
  b: XZ,
  bounds?: { min: Vec3; max: Vec3 },
): Pick<Walkway, "min" | "max"> {
  const cx = (x: number) => (bounds ? clamp(x, bounds.min[0], bounds.max[0]) : x);
  const cz = (z: number) => (bounds ? clamp(z, bounds.min[2], bounds.max[2]) : z);
  return {
    min: [cx(Math.min(a[0], b[0])), cz(Math.min(a[1], b[1]))],
    max: [cx(Math.max(a[0], b[0])), cz(Math.max(a[1], b[1]))],
  };
}

/** Smallest walkway side worth keeping, meters (narrower drags are taps). */
export const MIN_WALKWAY_SIDE = 0.1;

export const walkwayBigEnough = (w: Pick<Walkway, "min" | "max">) =>
  w.max[0] - w.min[0] >= MIN_WALKWAY_SIDE && w.max[1] - w.min[1] >= MIN_WALKWAY_SIDE;

/** A table's local X/Z axes in the world (yaw turns local X about +Y, like three.js). */
function tableAxes(yaw: number) {
  return { x: [Math.cos(yaw), -Math.sin(yaw)] as XZ, z: [Math.sin(yaw), Math.cos(yaw)] as XZ };
}

/** Tabletop corners in world X/Z: (−,−), (+,−), (+,+), (−,+) in the table's local X/Z. */
export function tableCorners(table: Pick<Table, "center" | "yaw" | "size">): XZ[] {
  const { x, z } = tableAxes(table.yaw);
  const [hw, hd] = [table.size[0] / 2, table.size[1] / 2];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => [
    table.center[0] + x[0] * sx! * hw + z[0] * sz! * hd,
    table.center[2] + x[1] * sx! * hw + z[1] * sz! * hd,
  ]);
}

/** Smallest and largest tabletop side, meters (the manifest allows up to 10 m). */
export const TABLE_SIDE = { min: 0.2, max: 10 };

/**
 * Drags corner `index` (see `tableCorners`) to `to`, keeping the opposite corner where it is.
 * Returns the new center and size.
 */
export function resizeTableFromCorner(
  table: Pick<Table, "center" | "yaw" | "size">,
  index: number,
  to: XZ,
): Pick<Table, "center" | "size"> {
  const corners = tableCorners(table);
  const fixed = corners[(index + 2) % 4]!;
  const { x, z } = tableAxes(table.yaw);
  const dx = to[0] - fixed[0];
  const dz = to[1] - fixed[1];
  // The dragged corner keeps its side of the fixed one (a table can't be turned inside out).
  const signX = index === 1 || index === 2 ? 1 : -1;
  const signZ = index >= 2 ? 1 : -1;
  const w = clamp((dx * x[0] + dz * x[1]) * signX, TABLE_SIDE.min, TABLE_SIDE.max);
  const d = clamp((dx * z[0] + dz * z[1]) * signZ, TABLE_SIDE.min, TABLE_SIDE.max);
  const ox = (signX * w) / 2;
  const oz = (signZ * d) / 2;
  return {
    center: [fixed[0] + x[0] * ox + z[0] * oz, table.center[1], fixed[1] + x[1] * ox + z[1] * oz],
    size: [w, d],
  };
}

/** Yaw that faces from `from` towards `to` (yaw 0 faces +Z, as everywhere in the engine). */
export const yawTowards = (from: XZ, to: XZ) =>
  wrapAngle(Math.atan2(to[0] - from[0], to[1] - from[1]));

/** Turns a yaw to the next whole multiple of `degrees` in that direction. */
export function turnYaw(yaw: number, degrees: number): number {
  const step = (Math.abs(degrees) * Math.PI) / 180;
  const k = degrees > 0 ? Math.floor(yaw / step + 1e-6) + 1 : Math.ceil(yaw / step - 1e-6) - 1;
  return wrapAngle(k * step);
}

/** Spacing between seats placed along a couch, meters. */
export const SEAT_SPACING = 0.6;

/**
 * Seats along a couch, from one end (`a`) to the other (`b`): one per `spacing`, centered on the
 * line, facing perpendicular to it on the side of `facing` (e.g. where the owner is looking from).
 */
export function seatsAlongLine(
  a: Vec3,
  b: Vec3,
  facing: XZ,
  spacing = SEAT_SPACING,
): Array<{ position: Vec3; yaw: number }> {
  const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.max(1, Math.round(length / spacing));
  // Perpendicular to the line, flipped to point at `facing`.
  let nx = -(b[2] - a[2]);
  let nz = b[0] - a[0];
  const mid: XZ = [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2];
  if (nx * (facing[0] - mid[0]) + nz * (facing[1] - mid[1]) < 0) [nx, nz] = [-nx, -nz];
  const yaw = length > 1e-6 ? wrapAngle(Math.atan2(nx, nz)) : yawTowards(mid, facing);
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    return {
      position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
      yaw,
    };
  });
}
