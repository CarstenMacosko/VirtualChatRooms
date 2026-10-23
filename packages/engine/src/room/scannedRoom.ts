import type { ManifestTransform, RoomManifest } from "@vcr/protocol";
import type { Vec3 } from "../math";
import { SAMPLE_ROOM } from "./sampleRoom";

/**
 * What the runtime needs to know about the room it's in, whether it's the procedural sample
 * room or a scan described by a manifest (PLAN.md § 3.3).
 */
export interface RoomLayout {
  bounds: { min: Vec3; max: Vec3 };
  spawnPoints: Array<{ position: Vec3; yaw: number }>;
  lighting: { ambientColor: string; intensity: number };
}

export const SAMPLE_ROOM_LAYOUT: RoomLayout = {
  bounds: SAMPLE_ROOM.bounds,
  spawnPoints: SAMPLE_ROOM.spawnPoints,
  lighting: SAMPLE_ROOM.lighting,
};

export function scannedRoomLayout(manifest: RoomManifest): RoomLayout {
  return {
    bounds: manifest.bounds,
    spawnPoints: manifest.spawnPoints,
    lighting: manifest.lighting,
  };
}

/**
 * The manifest's file-to-world transform as a column-major 4×4 matrix (three.js `Matrix4`
 * layout): world = translation + metersPerUnit · rotation(file).
 */
export function manifestMatrix(t: ManifestTransform): number[] {
  const [x, y, z, w] = t.rotation;
  const s = t.metersPerUnit;
  const [tx, ty, tz] = t.translation;
  return [
    s * (1 - 2 * (y * y + z * z)),
    s * 2 * (x * y + z * w),
    s * 2 * (x * z - y * w),
    0,
    s * 2 * (x * y - z * w),
    s * (1 - 2 * (x * x + z * z)),
    s * 2 * (y * z + x * w),
    0,
    s * 2 * (x * z + y * w),
    s * 2 * (y * z - x * w),
    s * (1 - 2 * (x * x + y * y)),
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** Collision mesh vertices (file space, xyz interleaved) moved into the world. */
export function collisionToWorld(positions: Float32Array, t: ManifestTransform): Float32Array {
  const m = manifestMatrix(t);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return out;
}
