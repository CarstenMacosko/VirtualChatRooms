import { z } from "zod";

/**
 * Versioned room manifest (PLAN.md § 3.3). Objects are "loose" so a client built for v2 keeps
 * working when later releases add fields. Storage keys, not URLs: the API turns keys into
 * signed, session-scoped URLs when someone joins (D12).
 *
 * Coordinates: the splat and collision mesh stay in the coordinates of the file they came from
 * ("file space"); `transform` maps file space into the world (meters, +Y up, floor at y = 0).
 * Bounds, spawn points, seats and zones are already in world space.
 *
 * v2 (Phase 4) adds the explicit file-to-world `transform.rotation` / `transform.translation`,
 * `splat.format`, `collision.format` and `transform.scaleSource`. v1 manifests are migrated on
 * parse (`migrateManifestV1`).
 */

export const SUPPORTED_MANIFEST_VERSION = 2;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
type Vec3 = z.infer<typeof Vec3>;
/** [x, y, z, w] */
const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const StorageKey = z.string().min(1);

/** Splat file formats Spark loads and the post-processing reads. */
export const SplatFormat = z.enum(["ply", "spz"]);
export type SplatFormat = z.infer<typeof SplatFormat>;

const SplatAsset = z.looseObject({
  key: StorageKey,
  count: z.number().int().positive(),
  format: SplatFormat,
});

export const Seat = z.looseObject({
  id: z.number().int().nonnegative().max(0xffff),
  position: Vec3,
  yaw: z.number(),
  height: z.number().positive(),
  kind: z.enum(["chair", "sofa", "bench", "floor"]),
});
export type Seat = z.infer<typeof Seat>;

const ZoneShape = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("circle"), center: Vec3, radius: z.number().positive() }),
  z.looseObject({ type: z.literal("box"), min: Vec3, max: Vec3 }),
]);

export const Zone = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(["conversation", "game", "quiet"]),
  shape: ZoneShape,
});
export type Zone = z.infer<typeof Zone>;

/**
 * Where the real-world scale came from: the file was already in meters, it was estimated from
 * the ceiling or the walls' height, or the owner set it.
 */
export const ScaleSource = z.enum(["file", "ceiling", "walls", "user"]);
export type ScaleSource = z.infer<typeof ScaleSource>;

export const ManifestTransform = z.looseObject({
  /** world = translation + metersPerUnit · rotate(rotation, file). */
  metersPerUnit: z.number().positive(),
  rotation: Quat,
  translation: Vec3,
  /** The file's up direction (file space) and floor height along it (file units). */
  up: Vec3,
  floorY: z.number(),
  scaleSource: ScaleSource,
});
export type ManifestTransform = z.infer<typeof ManifestTransform>;

export const RoomManifest = z.looseObject({
  manifestVersion: z.literal(SUPPORTED_MANIFEST_VERSION),
  roomId: z.string().min(1),
  splat: SplatAsset.extend({ lods: z.array(SplatAsset).default([]) }),
  /** A coarse triangle mesh (GLB) in file space, like the splat (ADR 0002). */
  collision: z.looseObject({
    key: StorageKey,
    triangles: z.number().int().positive(),
    format: z.literal("glb"),
  }),
  navmesh: z.looseObject({ key: StorageKey }).nullable().default(null),
  transform: ManifestTransform,
  bounds: z.looseObject({ min: Vec3, max: Vec3 }),
  spawnPoints: z.array(z.looseObject({ position: Vec3, yaw: z.number() })).min(1),
  seats: z.array(Seat).default([]),
  zones: z.array(Zone).default([]),
  lighting: z
    .looseObject({
      ambientColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      intensity: z.number().nonnegative(),
    })
    .default({ ambientColor: "#ffffff", intensity: 1 }),
});
export type RoomManifest = z.infer<typeof RoomManifest>;
export type RoomManifestInput = z.input<typeof RoomManifest>;

export class UnsupportedManifestError extends Error {
  override name = "UnsupportedManifestError";
}

/** Shortest rotation taking unit vector `from` onto +Y, as [x, y, z, w]. */
export function rotationToYUp(
  from: readonly [number, number, number],
): [number, number, number, number] {
  const len = Math.hypot(from[0], from[1], from[2]) || 1;
  const [fx, fy, fz] = [from[0] / len, from[1] / len, from[2] / len];
  // Upside down: half a turn about X (the axis is ambiguous; X matches Spark's usual flip).
  if (fy < -0.999999) return [1, 0, 0, 0];
  // axis = from × Y = (-z, 0, x); w = 1 + from·Y, then normalize.
  const q: [number, number, number, number] = [-fz, 0, fx, 1 + fy];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * v1 → v2. v1 assumed the splat was already in world orientation apart from `up` and `floorY`,
 * with every format implied by the key's extension.
 */
export function migrateManifestV1(v1: Record<string, unknown>): Record<string, unknown> {
  const transform = (v1.transform ?? {}) as { metersPerUnit?: number; up?: Vec3; floorY?: number };
  const metersPerUnit = transform.metersPerUnit ?? 1;
  const up = transform.up ?? [0, 1, 0];
  const floorY = transform.floorY ?? 0;
  const formatOf = (key: unknown) =>
    typeof key === "string" && key.toLowerCase().endsWith(".ply") ? "ply" : "spz";
  const splat = (v1.splat ?? {}) as { key?: unknown; lods?: Array<{ key?: unknown }> };
  return {
    ...v1,
    manifestVersion: 2,
    splat: {
      ...splat,
      format: formatOf(splat.key),
      lods: (splat.lods ?? []).map((lod) => ({ ...lod, format: formatOf(lod.key) })),
    },
    collision: { ...(v1.collision as object), format: "glb" },
    transform: {
      ...transform,
      metersPerUnit,
      up,
      floorY,
      rotation: rotationToYUp(up),
      translation: [0, -floorY * metersPerUnit, 0],
      scaleSource: "file",
    },
  };
}

export function parseRoomManifest(input: unknown): RoomManifest {
  const version = (input as { manifestVersion?: unknown } | null)?.manifestVersion;
  if (typeof version === "number" && version > SUPPORTED_MANIFEST_VERSION) {
    throw new UnsupportedManifestError(
      `manifest version ${version} is newer than this client supports (${SUPPORTED_MANIFEST_VERSION})`,
    );
  }
  if (version === 1) return RoomManifest.parse(migrateManifestV1(input as Record<string, unknown>));
  return RoomManifest.parse(input);
}
