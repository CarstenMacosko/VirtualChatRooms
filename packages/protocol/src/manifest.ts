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
 * `splat.format`, `collision.format` and `transform.scaleSource`. v3 lets a room be a textured
 * mesh instead of splats: exactly one of `splat` and `mesh` is set. Older manifests are migrated
 * on parse (`migrateManifestV1`, `migrateManifestV2`).
 *
 * Room setup (what the owner sets after uploading, see `RoomSetup` in rooms.ts): `walkways` open
 * paths the collision mesh blocks, `seats` are where people can sit, and `tables` are where games
 * can be played. Post-processing may suggest seats and tables (`source: "auto"`).
 */

export const SUPPORTED_MANIFEST_VERSION = 3;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
type Vec3 = z.infer<typeof Vec3>;
/** World X and Z, meters. */
const Vec2 = z.tuple([z.number(), z.number()]);
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

/** A textured mesh room (a photogrammetry scan's GLB), drawn as it was captured. */
const MeshAsset = z.looseObject({
  key: StorageKey,
  triangles: z.number().int().positive(),
  format: z.literal("glb"),
});

/** Who placed a seat or table: post-processing's furniture detection, or the room's owner. */
export const SetupSource = z.enum(["auto", "user"]);
export type SetupSource = z.infer<typeof SetupSource>;

/**
 * Somewhere one person can sit (a couch has one per cushion). `position` is the point on the
 * seat surface the hips rest on (world space), `yaw` the direction the sitter faces, `height`
 * the seat surface above the floor.
 */
export const Seat = z.looseObject({
  id: z.number().int().nonnegative().max(0xffff),
  position: Vec3,
  yaw: z.number(),
  height: z.number().positive(),
  kind: z.enum(["chair", "sofa", "bench", "floor"]),
  source: SetupSource.default("user"),
});
export type Seat = z.infer<typeof Seat>;

/**
 * A rectangle of floor (world X/Z, axis-aligned: rooms are squared to X and Z) that people can
 * walk through even where the collision mesh says otherwise, e.g. scan clutter in a doorway.
 * Collision above the floor inside it is removed; the floor stays.
 */
export const Walkway = z
  .looseObject({ id: z.string().min(1).max(40), min: Vec2, max: Vec2 })
  .refine((w) => w.min[0] < w.max[0] && w.min[1] < w.max[1], {
    message: "A walkway's min must be below its max.",
  });
export type Walkway = z.infer<typeof Walkway>;

/** Games a table can host. */
export const TableGame = z.enum(["jigsaw"]);
export type TableGame = z.infer<typeof TableGame>;

/**
 * A table games are played on. `center` is the middle of the tabletop (world space, at its
 * surface), `yaw` turns the table's local X axis about +Y, and `size` is its [width, depth]
 * along local X and Z, in meters.
 */
export const Table = z.looseObject({
  id: z.string().min(1).max(40),
  name: z.string().max(40).default(""),
  center: Vec3,
  yaw: z.number(),
  size: z.tuple([z.number().positive().max(10), z.number().positive().max(10)]),
  source: SetupSource.default("user"),
  /** Games people can start here; empty for a suggested table nobody has set up. */
  games: z.array(TableGame).default([]),
});
export type Table = z.infer<typeof Table>;

/**
 * A projector screen hung in the room (room setup): `center` is the middle of its face, which
 * faces `yaw` (0 faces +Z). It shows whatever someone in the call is sharing.
 */
export const Screen = z.looseObject({
  id: z.string().min(1).max(40),
  center: Vec3,
  yaw: z.number(),
  /** [width, height], meters. */
  size: z.tuple([z.number().min(0.3).max(8), z.number().min(0.2).max(5)]),
});
export type Screen = z.infer<typeof Screen>;

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

export const RoomManifest = z
  .looseObject({
    manifestVersion: z.literal(SUPPORTED_MANIFEST_VERSION),
    roomId: z.string().min(1),
    /** What the room looks like: splats or a textured mesh (exactly one). */
    splat: SplatAsset.extend({ lods: z.array(SplatAsset).default([]) })
      .nullable()
      .default(null),
    mesh: MeshAsset.nullable().default(null),
    /** A coarse triangle mesh (GLB) in file space, like the splat or mesh (ADR 0002). */
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
    walkways: z.array(Walkway).default([]),
    tables: z.array(Table).default([]),
    screens: z.array(Screen).default([]),
    zones: z.array(Zone).default([]),
    lighting: z
      .looseObject({
        ambientColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        intensity: z.number().nonnegative(),
      })
      .default({ ambientColor: "#ffffff", intensity: 1 }),
  })
  .refine((m) => (m.splat === null) !== (m.mesh === null), {
    message: "A room has either splats or a mesh.",
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

/** v2 → v3: every v2 room is splats. */
export function migrateManifestV2(v2: Record<string, unknown>): Record<string, unknown> {
  return { ...v2, manifestVersion: 3, mesh: null };
}

export function parseRoomManifest(input: unknown): RoomManifest {
  const version = (input as { manifestVersion?: unknown } | null)?.manifestVersion;
  if (typeof version === "number" && version > SUPPORTED_MANIFEST_VERSION) {
    throw new UnsupportedManifestError(
      `manifest version ${version} is newer than this client supports (${SUPPORTED_MANIFEST_VERSION})`,
    );
  }
  let manifest = input as Record<string, unknown>;
  if (version === 1) manifest = migrateManifestV1(manifest);
  if (version === 1 || version === 2) manifest = migrateManifestV2(manifest);
  return RoomManifest.parse(manifest);
}
