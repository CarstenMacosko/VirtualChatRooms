import type { BuiltInRoomId, Seat, Table } from "@vcr/protocol";
import type { BoxCollider } from "../locomotion/physics";
import type { Vec3 } from "../math";
import type { RoomLayout } from "./scannedRoom";

/**
 * Rooms that ship with the app, described once as solid parts with clean surfaces: the web client
 * draws real geometry from them (not splats), and their collision, seats and game tables come
 * from the same description, so they always match what people see.
 */

/** How a part's surface looks; the renderer maps each to a material. */
export type Finish =
  | "paint"
  | "trim"
  | "wood"
  | "darkWood"
  | "fabric"
  | "leather"
  | "marble"
  | "brass"
  | "metal"
  | "carpet"
  | "glow";

/** Pictures the renderer paints onto flat panels and floors. */
export type Picture =
  | "parquet"
  | "rug"
  | "window"
  | "door"
  | "painting"
  | "books"
  | "firebox"
  | "flag"
  | "ceiling"
  | "carpet"
  | "acoustic"
  | "cityWindow";

interface PartBase {
  color: string;
  finish: Finish;
}

/** A box, turned `yaw` about +Y. */
export interface BoxPart extends PartBase {
  kind: "box";
  center: Vec3;
  size: Vec3;
  yaw?: number;
  /** Blocks walking and the camera. */
  collide?: boolean;
  /** A picture on its faces (repeated per meter for floors and walls). */
  picture?: Picture;
}

/** An upright cylinder (or cone, with a different top radius). */
export interface CylinderPart extends PartBase {
  kind: "cylinder";
  center: Vec3;
  radius: number;
  radiusTop?: number;
  height: number;
  collide?: boolean;
}

export interface SpherePart extends PartBase {
  kind: "sphere";
  center: Vec3;
  radius: number;
}

/** A flat oval lying at height `y` (floor, rug, ceiling), facing up, or down when `down`. */
export interface OvalPart extends PartBase {
  kind: "oval";
  y: number;
  radii: [number, number];
  picture?: Picture;
  down?: boolean;
}

/**
 * A band of an oval wall around the origin from `y0` to `y1`, seen from inside. `collide` makes
 * the whole wall block (only one band needs it).
 */
export interface WallBandPart extends PartBase {
  kind: "wallBand";
  radii: [number, number];
  y0: number;
  y1: number;
  collide?: boolean;
}

/** A flat picture (window, door, painting) facing `yaw`. */
export interface PanelPart extends PartBase {
  kind: "panel";
  center: Vec3;
  size: [number, number];
  yaw: number;
  picture: Picture;
}

/**
 * A projector screen facing `yaw`: shows whatever someone in the call is sharing, or a hint to
 * share when nobody is.
 */
export interface ScreenPart extends PartBase {
  kind: "screen";
  center: Vec3;
  size: [number, number];
  yaw: number;
}

export type RoomPart =
  BoxPart | CylinderPart | SpherePart | OvalPart | WallBandPart | PanelPart | ScreenPart;

export interface BuiltInRoom {
  id: BuiltInRoomId;
  name: string;
  bounds: { min: Vec3; max: Vec3 };
  spawnPoints: Array<{ position: Vec3; yaw: number }>;
  seats: Seat[];
  tables: Table[];
  lighting: { ambientColor: string; intensity: number };
  /** Extra lights the renderer adds (the scene already has soft overall light). */
  lights: Array<{ position: Vec3; intensity: number; color: string; distance: number }>;
  parts: RoomPart[];
}

/**
 * A point `inset` meters in from an oval wall (half widths `rx`, `rz`) at `angle` around it: 0 is
 * +Z, π/2 is +X. `yaw` faces into the room.
 */
export function onOval(
  rx: number,
  rz: number,
  angle: number,
  inset = 0,
  y = 0,
): { position: Vec3; yaw: number } {
  const x = rx * Math.sin(angle);
  const z = rz * Math.cos(angle);
  // The ellipse's outward normal is (x/rx², z/rz²).
  const nx = x / rx ** 2;
  const nz = z / rz ** 2;
  const n = Math.hypot(nx, nz);
  return {
    position: [x - (nx / n) * inset, y, z - (nz / n) * inset],
    yaw: Math.atan2(-nx, -nz),
  };
}

export const box = (
  center: Vec3,
  size: Vec3,
  color: string,
  finish: Finish,
  opts: { collide?: boolean; yaw?: number; picture?: Picture } = {},
): BoxPart => ({
  kind: "box",
  center,
  size,
  color,
  finish,
  collide: opts.collide ?? true,
  ...(opts.yaw && { yaw: opts.yaw }),
  ...(opts.picture && { picture: opts.picture }),
});

/** A seat for `seats`: `position` is the middle of the seat's top, `yaw` the way the sitter faces. */
export const seat = (
  id: number,
  position: Vec3,
  yaw: number,
  kind: Seat["kind"] = "chair",
): Seat => ({ id, position, yaw, height: position[1], kind, source: "user" });

/** Segments a collidable oval wall is cut into, so the curve blocks everywhere. */
const OVAL_SEGMENTS = 64;
const WALL_THICKNESS = 0.3;

/** A room's collision: its floor and ceiling, collidable parts, and oval walls. */
export function builtInRoomColliders(room: BuiltInRoom): BoxCollider[] {
  const { min, max } = room.bounds;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const half: [number, number] = [(max[0] - min[0]) / 2 + 1, (max[2] - min[2]) / 2 + 1];
  const out: BoxCollider[] = [
    { center: [cx, min[1] - 0.1, cz], halfExtents: [half[0], 0.1, half[1]] },
    { center: [cx, max[1] + 0.1, cz], halfExtents: [half[0], 0.1, half[1]] },
  ];
  for (const part of room.parts) {
    if (part.kind === "box" && part.collide) {
      out.push({
        center: part.center,
        halfExtents: [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2],
        ...(part.yaw && { yaw: part.yaw }),
      });
    } else if (part.kind === "cylinder" && part.collide) {
      const r = Math.max(part.radius, part.radiusTop ?? 0);
      out.push({ center: part.center, halfExtents: [r, part.height / 2, r] });
    } else if (part.kind === "wallBand" && part.collide) {
      const [rx, rz] = part.radii;
      const h = (part.y1 - part.y0) / 2;
      for (let i = 0; i < OVAL_SEGMENTS; i++) {
        const a = (i / OVAL_SEGMENTS) * 2 * Math.PI;
        const b = ((i + 1) / OVAL_SEGMENTS) * 2 * Math.PI;
        const [ax, , az] = onOval(rx, rz, a).position;
        const [bx, , bz] = onOval(rx, rz, b).position;
        const { yaw: inward } = onOval(rx, rz, (a + b) / 2);
        const dx = bx - ax;
        const dz = bz - az;
        // Half a thickness outside the wall's surface, so the inside face is the wall.
        const t = WALL_THICKNESS / 2;
        out.push({
          center: [
            (ax + bx) / 2 - Math.sin(inward) * t,
            part.y0 + h,
            (az + bz) / 2 - Math.cos(inward) * t,
          ],
          halfExtents: [Math.hypot(dx, dz) / 2 + 0.05, h, t],
          yaw: Math.atan2(-dz, dx),
        });
      }
    }
  }
  return out;
}

/** What the runtime needs to know about a built-in room. */
export function builtInRoomLayout(room: BuiltInRoom): RoomLayout {
  return {
    bounds: room.bounds,
    spawnPoints: room.spawnPoints,
    lighting: room.lighting,
    seats: room.seats,
    tables: room.tables,
    walkways: [],
    // Built-in rooms have open floor around their spawn points.
    spawnSpread: [0.8, 0.6],
  };
}
