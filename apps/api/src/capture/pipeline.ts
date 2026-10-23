import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  MAX_SCAN_SPLATS,
  parseRoomManifest,
  type RoomManifest,
  type RoomManifestInput,
  type ScanDetails,
  type SplatFormat,
  type UpAxis,
} from "@vcr/protocol";
import type { ObjectStorage } from "../storage";
import { analyzeRoom, boxesToTriangles, qconj, qrotate, type RoomAnalysis } from "./analyze";
import { writeCollisionGlb } from "./glb";
import { readSplatPoints, SplatFileError, sniffSplatFormat } from "./splatFile";

/** Storage keys for a room's files. Everything under the prefix goes when the room is deleted. */
export const roomKeys = (roomId: string) => ({
  prefix: `rooms/${roomId}/`,
  source: (format: SplatFormat) => `rooms/${roomId}/scan.${format}`,
  collision: `rooms/${roomId}/collision.glb`,
  manifest: `rooms/${roomId}/manifest.json`,
});

export interface ProcessResult {
  manifest: RoomManifest;
  manifestKey: string;
  details: ScanDetails;
}

/** A problem with the scan itself (not our servers), worded for the person who uploaded it. */
export class ScanRejectedError extends Error {
  override name = "ScanRejectedError";
}

/**
 * Stages 3–6 of the capture pipeline for an uploaded splat (PLAN.md § 4.1): validate, analyze,
 * write the collision mesh and the manifest. The splat itself is served as uploaded for now
 * (no `.spz` conversion or mobile LOD yet). CPU only, in-process; the reading streams and the
 * analysis runs between event-loop turns so the API keeps answering meanwhile.
 */
export async function processScan(
  storage: ObjectStorage,
  roomId: string,
  format: SplatFormat,
  opts: { up?: UpAxis; heightMeters?: number; onProgress?: (p: number) => void } = {},
): Promise<ProcessResult> {
  const keys = roomKeys(roomId);
  const sourceKey = keys.source(format);
  const progress = opts.onProgress ?? (() => {});

  // 1. Prepare: is it really the format it claims to be?
  const head = await firstBytes(await storage.stream(sourceKey), 16);
  if (sniffSplatFormat(head) !== format) {
    throw new ScanRejectedError(
      format === "ply"
        ? "This file isn't a PLY splat. Export the scan as a Gaussian splat (.ply or .spz)."
        : "This file isn't an SPZ splat. Export the scan as a Gaussian splat (.ply or .spz).",
    );
  }
  progress(0.1);

  let points;
  try {
    points = await readSplatPoints(await storage.stream(sourceKey), format, {
      maxSplats: MAX_SCAN_SPLATS,
    });
  } catch (err) {
    if (err instanceof SplatFileError) throw new ScanRejectedError(err.message);
    throw err;
  }
  progress(0.6);
  await yieldToEventLoop();

  let analysis: RoomAnalysis;
  try {
    analysis = analyzeRoom(points, opts);
  } catch (err) {
    if (err instanceof Error && err.name === "RoomAnalysisError") {
      throw new ScanRejectedError(err.message);
    }
    throw err;
  }
  progress(0.85);
  await yieldToEventLoop();

  // The collision mesh lives in the splat's file space, like a provider's mesh would, so one
  // transform places both (and rescaling never rewrites it).
  const { metersPerUnit, rotation, translation } = analysis.transform;
  const inverse = qconj(rotation);
  const triangles = boxesToTriangles(analysis.boxes, (w) =>
    qrotate(inverse, [
      (w[0] - translation[0]) / metersPerUnit,
      (w[1] - translation[1]) / metersPerUnit,
      (w[2] - translation[2]) / metersPerUnit,
    ]),
  );
  await storage.put(
    keys.collision,
    writeCollisionGlb(triangles.positions, triangles.indices),
    "model/gltf-binary",
  );

  const input: RoomManifestInput = {
    manifestVersion: 2,
    roomId,
    splat: { key: sourceKey, count: points.count, format, lods: [] },
    collision: { key: keys.collision, triangles: triangles.indices.length / 3, format: "glb" },
    navmesh: null,
    transform: analysis.transform,
    bounds: analysis.bounds,
    spawnPoints: analysis.spawnPoints,
    seats: [],
    zones: [],
    lighting: { ambientColor: "#ffffff", intensity: 1 },
  };
  const manifest = parseRoomManifest(input);
  await storage.put(keys.manifest, JSON.stringify(manifest), "application/json");
  progress(1);
  return {
    manifest,
    manifestKey: keys.manifest,
    details: {
      format,
      splats: points.count,
      size: round(analysis.size),
      scaleSource: analysis.transform.scaleSource,
      up: analysis.upAxis,
    },
  };
}

/**
 * Rescales a processed room so it's `heightMeters` tall. World coordinates scale about the
 * origin (the floor's center), so this only touches the manifest: the collision mesh is in file
 * space.
 */
export async function rescaleRoom(
  storage: ObjectStorage,
  manifestKey: string,
  heightMeters: number,
  details: ScanDetails,
): Promise<ProcessResult> {
  const manifest = parseRoomManifest(JSON.parse((await storage.get(manifestKey)).toString("utf8")));
  const k = heightMeters / (manifest.bounds.max[1] || 1);
  const scale = (v: [number, number, number]) => v.map((c) => c * k) as [number, number, number];
  const next: RoomManifest = {
    ...manifest,
    transform: {
      ...manifest.transform,
      metersPerUnit: manifest.transform.metersPerUnit * k,
      translation: scale(manifest.transform.translation),
      scaleSource: "user",
    },
    bounds: { min: scale(manifest.bounds.min), max: scale(manifest.bounds.max) },
    spawnPoints: manifest.spawnPoints.map((s) => ({ ...s, position: scale(s.position) })),
    seats: manifest.seats.map((s) => ({ ...s, position: scale(s.position), height: s.height * k })),
  };
  await storage.put(manifestKey, JSON.stringify(next), "application/json");
  return {
    manifest: next,
    manifestKey,
    details: {
      ...details,
      size: round({
        width: details.size.width * k,
        depth: details.size.depth * k,
        height: details.size.height * k,
      }),
      scaleSource: "user",
    },
  };
}

const round = (size: ScanDetails["size"]) => ({
  width: Math.round(size.width * 100) / 100,
  depth: Math.round(size.depth * 100) / 100,
  height: Math.round(size.height * 100) / 100,
});

async function firstBytes(stream: NodeJS.ReadableStream & { destroy(): void }, n: number) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length >= n) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, n);
}
