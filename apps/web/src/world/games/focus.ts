import type { CameraPose, Vec3 } from "@vcr/engine";
import type { TableFrame, TableViewArea } from "@vcr/games-sdk";

/**
 * Takes over the camera from the follow rig while someone plays at a table. The World asks it
 * every frame; it blends in and out so the camera glides between the two.
 */
export interface CameraFocus {
  /** While true, movement and look input is ignored. */
  readonly holdsInput: boolean;
  /** The camera to use this frame, given the follow camera's; null to use the follow camera. */
  view(follow: CameraPose, dt: number): CameraPose | null;
}

/**
 * Games draw this far above the manifest's tabletop: a scan's surface is fuzzy (splats spread a
 * centimeter or so either side of it), and pieces sunk into it would be hidden.
 */
export const TABLETOP_CLEARANCE = 0.012;

/** How far the camera looks down at the table (radians above horizontal). */
const PITCH = 1.12;
const BLEND_SECONDS = 0.6;
/** On-screen size of a piece (CSS pixels) when zoomed all the way in, and by default. */
const CLOSEST_PIECE_PX = 120;
const DEFAULT_PIECE_PX = 46;
/** Keep the camera this far below the room's ceiling. */
const CEILING_CLEARANCE = 0.25;

/** Table-local (x, y, z) to world, the same way the table's scene group is placed. */
export function tableToWorld(table: TableFrame, x: number, y: number, z: number, out: Vec3) {
  const c = Math.cos(table.yaw);
  const s = Math.sin(table.yaw);
  out[0] = table.center[0] + x * c + z * s;
  out[1] = table.center[1] + y;
  out[2] = table.center[2] - x * s + z * c;
  return out;
}

/** World (x, z) to table-local (x, z). */
export function worldToTable(
  table: TableFrame,
  x: number,
  z: number,
  out: { x: number; z: number },
) {
  const c = Math.cos(table.yaw);
  const s = Math.sin(table.yaw);
  const dx = x - table.center[0];
  const dz = z - table.center[2];
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

/** Which side of the table (unit vector in table-local x/z) someone at world (x, z) is on. */
export function sideOf(table: TableFrame, x: number, z: number): [number, number] {
  const local = worldToTable(table, x, z, { x: 0, z: 0 });
  const [w, d] = table.size;
  if (Math.abs(local.z) / d >= Math.abs(local.x) / w) return [0, local.z >= 0 ? 1 : -1];
  return [local.x >= 0 ? 1 : -1, 0];
}

type FocusArea = TableViewArea;

/** The "puzzle view" camera: from the player's side, looking down at the table. */
export class TableFocus implements CameraFocus {
  holdsInput = false;
  private table: TableFrame | null = null;
  private side: [number, number] = [0, 1];
  private area: FocusArea = { bounds: [0.5, 0.5], piece: 0.05 };
  private pan = { x: 0, z: 0 };
  private distance = 1;
  /** Null until the first frame after entering picks a starting zoom. */
  private zoom: number | null = null;
  private blend = 0;
  private viewport = { aspect: 1, height: 800, fov: 60 };
  private ceiling = Infinity;
  private readonly target: CameraPose = { position: [0, 0, 0], lookAt: [0, 0, 0] };
  private readonly out: CameraPose = { position: [0, 0, 0], lookAt: [0, 0, 0] };

  get active() {
    return this.table !== null;
  }

  /** Starts (or, for a new game on the same table, re-fits) the view of `table`. */
  enter(table: TableFrame, side: [number, number], area: FocusArea, ceiling: number) {
    const same =
      this.table === table &&
      this.area.piece === area.piece &&
      this.area.bounds[0] === area.bounds[0] &&
      this.area.bounds[1] === area.bounds[1];
    this.table = table;
    this.side = side;
    this.area = area;
    this.ceiling = ceiling;
    this.holdsInput = true;
    if (!same) {
      this.pan = { x: 0, z: 0 };
      this.zoom = null;
    }
  }

  exit() {
    this.holdsInput = false;
    // The table stays until the blend back to the follow camera finishes.
  }

  setViewport(aspect: number, height: number, fov: number) {
    this.viewport.aspect = aspect;
    this.viewport.height = height;
    this.viewport.fov = fov;
  }

  /** Multiplies the camera distance (> 1 zooms out). */
  zoomBy(factor: number) {
    if (this.zoom !== null) this.zoom = this.clampZoom(this.zoom * factor);
  }

  /** Moves the view so the table follows a drag of (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number) {
    const metersPerPx = (2 * this.distance * this.tanHalf()) / this.viewport.height;
    const [sx, sz] = this.side;
    // Screen right on the table is (sz, -sx); screen down is the side, foreshortened.
    this.pan.x -= sz * dx * metersPerPx + (sx * dy * metersPerPx) / Math.sin(PITCH);
    this.pan.z -= -sx * dx * metersPerPx + (sz * dy * metersPerPx) / Math.sin(PITCH);
    const [hx, hz] = this.area.bounds;
    this.pan.x = Math.max(-hx, Math.min(hx, this.pan.x));
    this.pan.z = Math.max(-hz, Math.min(hz, this.pan.z));
  }

  view(follow: CameraPose, dt: number): CameraPose | null {
    const step = dt / BLEND_SECONDS;
    this.blend = this.holdsInput ? Math.min(1, this.blend + step) : Math.max(0, this.blend - step);
    if (this.blend === 0 && !this.holdsInput) this.table = null;
    const table = this.table;
    if (!table) return null;

    this.zoom ??= this.clampZoom(this.startingDistance());
    this.distance = this.zoom;
    const [sx, sz] = this.side;
    const back = Math.cos(PITCH) * this.distance;
    const up = Math.sin(PITCH) * this.distance;
    tableToWorld(table, this.pan.x, 0, this.pan.z, this.target.lookAt);
    tableToWorld(table, this.pan.x + sx * back, up, this.pan.z + sz * back, this.target.position);

    const t = this.blend * this.blend * (3 - 2 * this.blend); // smoothstep
    for (let i = 0; i < 3; i++) {
      this.out.position[i] =
        follow.position[i]! + (this.target.position[i]! - follow.position[i]!) * t;
      this.out.lookAt[i] = follow.lookAt[i]! + (this.target.lookAt[i]! - follow.lookAt[i]!) * t;
    }
    return this.out;
  }

  private tanHalf() {
    return Math.tan((this.viewport.fov * Math.PI) / 360);
  }

  /** Distance at which a piece looks `px` CSS pixels big. */
  private distanceForPiece(px: number) {
    return (this.area.piece * this.viewport.height) / (2 * this.tanHalf() * px);
  }

  /** Distance that shows everything on the table. */
  private fitAll() {
    const [hx, hz] = this.area.bounds;
    const sideways = this.side[0] !== 0;
    const across = 2 * (sideways ? hz : hx) + this.area.piece * 2;
    const along = 2 * (sideways ? hx : hz) + this.area.piece * 2;
    const tanHalf = this.tanHalf();
    return Math.max(
      (along * Math.sin(PITCH)) / (2 * tanHalf),
      across / (2 * tanHalf * this.viewport.aspect),
    );
  }

  /** Everything on the table if pieces are still big enough to pick up; otherwise closer. */
  private startingDistance() {
    return Math.min(this.fitAll(), this.distanceForPiece(DEFAULT_PIECE_PX));
  }

  private clampZoom(distance: number) {
    const closest = this.distanceForPiece(CLOSEST_PIECE_PX);
    const height = this.table ? this.ceiling - CEILING_CLEARANCE - this.table.center[1] : Infinity;
    const farthest = Math.max(closest, Math.min(this.fitAll() * 1.15, height / Math.sin(PITCH)));
    return Math.max(closest, Math.min(farthest, distance));
  }
}
