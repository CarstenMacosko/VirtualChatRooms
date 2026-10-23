import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  MAX_SCAN_SPLATS,
  parseRoomManifest,
  type RoomManifest,
  type RoomManifestInput,
  type ScanDetails,
  type ScanFormat,
  type UpAxis,
} from "@vcr/protocol";
import type { ObjectStorage } from "../storage";
import { analyzeRoom, boxesToTriangles, qconj, qrotate, type RoomAnalysis } from "./analyze";
import { writeCollisionGlb } from "./glb";
import { isGlb, MeshFileError, readGlbMesh, sampleSurface } from "./meshFile";
import {
  DEFAULT_MAX_POINTS,
  isPointCloudPly,
  type PointCloud,
  readPointCloud,
  readSplatPoints,
  SplatFileError,
  type SplatPoints,
  sniffSplatFormat,
  writeSpzColumns,
} from "./splatFile";
import { pointCloudToSplats } from "./surfels";

/** Storage keys for a room's files. Everything under the prefix goes when the room is deleted. */
export const roomKeys = (roomId: string) => ({
  prefix: `rooms/${roomId}/`,
  source: (format: ScanFormat) => `rooms/${roomId}/scan.${format}`,
  /** Splats made from an uploaded point cloud. */
  converted: `rooms/${roomId}/splats.spz`,
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
 * Stages 3–6 of the capture pipeline for an uploaded scan (PLAN.md § 4.1): validate, analyze,
 * write the collision mesh and the manifest. A splat or textured mesh is served as uploaded (no
 * mobile LOD yet); a plain point cloud is first turned into splats (surfels.ts) and served as
 * `.spz`. CPU only,
 * in-process; the reading streams and the heavy steps yield between event-loop turns so the API
 * keeps answering meanwhile.
 */
export async function processScan(
  storage: ObjectStorage,
  roomId: string,
  format: ScanFormat,
  opts: { up?: UpAxis; heightMeters?: number; onProgress?: (p: number) => void } = {},
): Promise<ProcessResult> {
  const keys = roomKeys(roomId);
  const sourceKey = keys.source(format);
  const progress = opts.onProgress ?? (() => {});

  // 1. Prepare: is it really the format it claims to be?
  const head = await firstBytes(await storage.stream(sourceKey), 64 * 1024);
  if ((isGlb(head) ? "glb" : sniffSplatFormat(head)) !== format) {
    throw new ScanRejectedError(
      `This file isn't ${format === "glb" ? "a GLB mesh" : `a ${format.toUpperCase()} splat`}. Export the scan as a Gaussian splat (.ply or .spz) or a textured mesh (.glb).`,
    );
  }
  progress(0.1);

  const pointCloud = format === "ply" && isPointCloudPly(head);
  let points: SplatPoints;
  let look: Pick<RoomManifestInput, "splat" | "mesh">;
  let triangleCount: number | undefined;
  try {
    if (format === "glb") {
      const mesh = readGlbMesh(await storage.get(sourceKey));
      triangleCount = mesh.indices.length / 3;
      progress(0.3);
      await yieldToEventLoop();
      points = sampleSurface(mesh, DEFAULT_MAX_POINTS);
      look = { splat: null, mesh: { key: sourceKey, triangles: triangleCount, format: "glb" } };
    } else if (pointCloud) {
      const cloud = await readPointCloud(await storage.stream(sourceKey), {
        maxSplats: MAX_SCAN_SPLATS,
      });
      progress(0.2);
      const splats = await pointCloudToSplats(cloud, {
        onProgress: (p) => progress(0.2 + 0.35 * p),
      });
      await storage.put(keys.converted, writeSpzColumns(splats), "application/octet-stream");
      points = cloudPoints(cloud);
      look = { splat: { key: keys.converted, format: "spz", count: points.count, lods: [] } };
    } else {
      points = await readSplatPoints(await storage.stream(sourceKey), format, {
        maxSplats: MAX_SCAN_SPLATS,
      });
      look = { splat: { key: sourceKey, format, count: points.count, lods: [] } };
    }
  } catch (err) {
    if (err instanceof SplatFileError || err instanceof MeshFileError) {
      throw new ScanRejectedError(err.message);
    }
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

  // The collision mesh lives in the scan's file space, like a provider's mesh would, so one
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
    manifestVersion: 3,
    roomId,
    ...look,
    collision: { key: keys.collision, triangles: triangles.indices.length / 3, format: "glb" },
    navmesh: null,
    transform: analysis.transform,
    bounds: analysis.bounds,
    spawnPoints: analysis.spawnPoints,
    seats: [],
    walkways: [],
    tables: [],
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
      ...(pointCloud && { pointCloud }),
      splats: format === "glb" ? 0 : points.count,
      ...(triangleCount !== undefined && { triangles: triangleCount }),
      size: round(analysis.size),
      scaleSource: analysis.transform.scaleSource,
      up: analysis.upAxis,
    },
  };
}

/**
 * Rescales a processed room so it's `heightMeters` tall. World coordinates scale about the
 * origin (the floor's center), so this only touches the manifest: the collision mesh is in file
 * space. The room's setup scales with it. (Processing again, for a new up axis, starts the
 * setup over: the floor and walls move.)
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
    walkways: manifest.walkways.map((w) => ({
      ...w,
      min: [w.min[0] * k, w.min[1] * k],
      max: [w.max[0] * k, w.max[1] * k],
    })),
    tables: manifest.tables.map((t) => ({
      ...t,
      center: scale(t.center),
      size: [t.size[0] * k, t.size[1] * k],
    })),
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

/** A point cloud's positions as the analysis reads them, subsampled like a splat file's. */
function cloudPoints(cloud: PointCloud): SplatPoints {
  const stride = Math.max(1, Math.ceil(cloud.count / DEFAULT_MAX_POINTS));
  const kept = Math.ceil(cloud.count / stride);
  const positions = new Float32Array(kept * 3);
  for (let k = 0; k < kept; k++) {
    positions.set(cloud.positions.subarray(k * stride * 3, k * stride * 3 + 3), k * 3);
  }
  return { count: cloud.count, positions, opacity: new Float32Array(kept).fill(1), stride };
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
