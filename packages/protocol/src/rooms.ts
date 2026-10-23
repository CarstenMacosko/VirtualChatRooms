import { z } from "zod";
import { RoomManifest, ScaleSource, SplatFormat } from "./manifest";

/**
 * Rooms and room capture (PLAN.md § 4.1). Phase 4's first slice imports a scan people already
 * made (Scaniverse, Polycam or the KIRI app, exported as a `.ply` or `.spz` Gaussian splat);
 * turning a recorded video into a room goes through a capture provider (KIRI Engine) later.
 */

export const RoomKind = z.enum(["sample", "scan"]);
export type RoomKind = z.infer<typeof RoomKind>;

export const RoomSummary = z.object({
  id: z.string(),
  name: z.string(),
  kind: RoomKind,
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** Sample rooms are always ready; scans go uploading → processing → ready (or failed). */
export const RoomStatus = z.enum(["uploading", "processing", "ready", "failed"]);
export type RoomStatus = z.infer<typeof RoomStatus>;

/** A direction in the scan file's own coordinates, for "this way is up". */
export const UpAxis = z.enum(["+x", "-x", "+y", "-y", "+z", "-z"]);
export type UpAxis = z.infer<typeof UpAxis>;

/** What post-processing found in a scan, for the owner's room list. */
export const ScanDetails = z.object({
  format: SplatFormat,
  splats: z.number().int().nonnegative(),
  /** Walkable floor's width and depth, and the room's height, in meters. */
  size: z.object({ width: z.number(), depth: z.number(), height: z.number() }),
  scaleSource: ScaleSource,
  /** The axis that was taken as up (null when the floor was tilted off every axis). */
  up: UpAxis.nullable(),
});
export type ScanDetails = z.infer<typeof ScanDetails>;

export const RoomInfo = RoomSummary.extend({
  status: RoomStatus,
  /** 0–1 while processing; null otherwise. */
  progress: z.number().min(0).max(1).nullable(),
  /** Why processing failed, as a sentence people can read. */
  error: z.string().nullable(),
  scan: ScanDetails.nullable(),
  createdAt: z.string(),
});
export type RoomInfo = z.infer<typeof RoomInfo>;

/** Scans can be large (phone exports are typically 50–300 MB). */
export const MAX_SCAN_BYTES = 500 * 1024 * 1024;
export const MIN_SCAN_BYTES = 1024;
/** Uploads go in parts of this size (S3's multipart minimum is 5 MB). */
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;
/** More than this and phones can't render the room. */
export const MAX_SCAN_SPLATS = 6_000_000;
/** Cost control (PLAN.md § 4.1): scan rooms per person. */
export const MAX_SCAN_ROOMS = 10;

/** What this server can do with captures: imports always work; video needs a provider key. */
export const CaptureOptions = z.object({
  maxScanBytes: z.number().int().positive(),
  formats: z.array(SplatFormat),
  video: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type CaptureOptions = z.infer<typeof CaptureOptions>;

export const RoomsResponse = z.object({ rooms: z.array(RoomInfo), capture: CaptureOptions });
export type RoomsResponse = z.infer<typeof RoomsResponse>;

export const CreateScanRequest = z.object({
  name: z.string().trim().min(1).max(60),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/\.(ply|spz)$/i, "Choose a .ply or .spz file exported from your scanning app."),
  size: z
    .number()
    .int()
    .min(MIN_SCAN_BYTES, "That file is too small to be a room scan.")
    .max(MAX_SCAN_BYTES, `Scans can be up to ${MAX_SCAN_BYTES / 1024 / 1024} MB.`),
});
export type CreateScanRequest = z.infer<typeof CreateScanRequest>;

/**
 * Where to PUT each part of the file. The URLs are signed and short-lived; parts can be retried.
 * Each successful PUT answers with an `ETag` header, which goes back in `CompleteUploadRequest`.
 */
export const UploadPlan = z.object({
  partSize: z.number().int().positive(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string() })),
  expiresAt: z.string(),
});
export type UploadPlan = z.infer<typeof UploadPlan>;

export const CreateScanResponse = z.object({ room: RoomInfo, upload: UploadPlan });
export type CreateScanResponse = z.infer<typeof CreateScanResponse>;

export const CompleteUploadRequest = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
    .min(1),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

export const UpdateRoomRequest = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    /** Rescales the room so it's this tall (the scale fallback when the estimate is off). */
    heightMeters: z.number().min(1.5).max(8).optional(),
    /** Re-runs post-processing with this axis as up, when the room came out on its side. */
    up: UpAxis.optional(),
  })
  .refine((r) => r.name !== undefined || r.heightMeters !== undefined || r.up !== undefined, {
    message: "Nothing to change.",
  });
export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequest>;

/**
 * A scanned room's manifest plus signed URLs for its storage keys, handed to each participant
 * when they join a live session (ADR 0012). Null in a join response means the sample room.
 * URLs may be relative to the API (local storage) or absolute (S3/R2).
 */
export const SceneAssets = z.object({
  manifest: RoomManifest,
  urls: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type SceneAssets = z.infer<typeof SceneAssets>;
