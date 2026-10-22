import { z } from "zod";

/**
 * Versioned room manifest (PLAN.md § 3.3). Objects are "loose" so a client built for v1 keeps
 * working when later releases add fields. Storage keys, not URLs: the API turns keys into
 * signed, session-scoped URLs when someone joins (D12).
 */

export const SUPPORTED_MANIFEST_VERSION = 1;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const StorageKey = z.string().min(1);

const SplatAsset = z.looseObject({
  key: StorageKey,
  count: z.number().int().positive(),
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

export const RoomManifest = z.looseObject({
  manifestVersion: z.literal(SUPPORTED_MANIFEST_VERSION),
  roomId: z.string().min(1),
  splat: SplatAsset.extend({ lods: z.array(SplatAsset).default([]) }),
  collision: z.looseObject({ key: StorageKey, triangles: z.number().int().positive() }),
  navmesh: z.looseObject({ key: StorageKey }).nullable().default(null),
  transform: z.looseObject({
    metersPerUnit: z.number().positive(),
    up: Vec3,
    floorY: z.number(),
  }),
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

export class UnsupportedManifestError extends Error {
  override name = "UnsupportedManifestError";
}

export function parseRoomManifest(input: unknown): RoomManifest {
  const version = (input as { manifestVersion?: unknown } | null)?.manifestVersion;
  if (typeof version === "number" && version > SUPPORTED_MANIFEST_VERSION) {
    throw new UnsupportedManifestError(
      `manifest version ${version} is newer than this client supports (${SUPPORTED_MANIFEST_VERSION})`,
    );
  }
  return RoomManifest.parse(input);
}
