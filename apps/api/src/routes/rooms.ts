import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  CompleteUploadRequest,
  CreateScanRequest,
  type CreateScanResponse,
  MAX_SCAN_BYTES,
  MAX_SCAN_ROOMS,
  parseRoomManifest,
  type RoomInfo,
  type RoomsResponse,
  ScanDetails,
  type SceneAssets,
  UPLOAD_PART_BYTES,
  UpdateRoomRequest,
} from "@vcr/protocol";
import type { Services } from "../app";
import { requireSession } from "../auth";
import { type JobOptions, roomInfo } from "../captures";
import { rescaleRoom, roomKeys } from "../capture/pipeline";
import type { Database } from "../db/client";
import { captureJobs, rooms, sessions } from "../db/schema";
import { type IdParams, parseBody, sendError } from "../http";
import type { ObjectStorage } from "../storage";

/** Upload URLs last long enough for a 300 MB scan on a slow connection. */
const UPLOAD_TTL_MS = 6 * 60 * 60_000;
/** Asset URLs are fetched right after joining; rejoining (every reconnect) issues fresh ones. */
export const ASSET_URL_TTL_MS = 60 * 60_000;

/** Everyone gets a sample room to start in, and it stays first in their list. */
export async function ensureSampleRoom(db: Database, ownerId: string) {
  const [sample] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.ownerId, ownerId), eq(rooms.kind, "sample")))
    .limit(1);
  if (sample) return;
  await db.insert(rooms).values({
    id: `rm_${randomUUID()}`,
    ownerId,
    name: "My living room",
    kind: "sample",
  });
}

/**
 * Signed URLs for a ready scan room's assets, scoped to one live session (ADR 0012). Null for
 * the sample room, which every client generates itself.
 */
export async function sceneAssets(
  storage: ObjectStorage,
  room: typeof rooms.$inferSelect,
  sessionId: string,
): Promise<SceneAssets | null> {
  if (room.kind !== "scan" || room.status !== "ready" || !room.manifestKey) return null;
  const manifest = parseRoomManifest(
    JSON.parse((await storage.get(room.manifestKey)).toString("utf8")),
  );
  const expiresAt = new Date(Date.now() + ASSET_URL_TTL_MS);
  const keys = [
    manifest.splat.key,
    ...manifest.splat.lods.map((l) => l.key),
    manifest.collision.key,
  ];
  const urls: Record<string, string> = {};
  for (const key of keys) urls[key] = await storage.signDownload(key, { expiresAt, sessionId });
  return { manifest, urls, expiresAt: expiresAt.toISOString() };
}

export function roomRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, storage, captures, gatherings, live } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };
  const me = (req: { session: { sub: string } | null }) => req.session!.sub;
  const changed = (userId: string) => live.send(userId, { type: "rooms-changed" });

  const ownRoom = async (id: string, ownerId: string) => {
    const [room] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, id), eq(rooms.ownerId, ownerId)));
    return room ?? null;
  };

  app.get("/rooms", auth, async (req): Promise<RoomsResponse> => {
    await ensureSampleRoom(db, me(req));
    // Uploads nobody finished before their URLs expired won't finish now.
    await db
      .update(rooms)
      .set({ status: "failed", error: "The upload didn't finish. Delete this room and try again." })
      .where(
        and(
          eq(rooms.ownerId, me(req)),
          eq(rooms.status, "uploading"),
          lt(rooms.createdAt, new Date(Date.now() - UPLOAD_TTL_MS)),
        ),
      );
    const owned = await db
      .select()
      .from(rooms)
      .where(eq(rooms.ownerId, me(req)))
      .orderBy(asc(rooms.createdAt));
    // The sample room first: it's the default for a gathering.
    owned.sort((a, b) => Number(b.kind === "sample") - Number(a.kind === "sample"));
    return {
      rooms: owned.map(roomInfo),
      capture: {
        maxScanBytes: MAX_SCAN_BYTES,
        formats: ["ply", "spz"],
        video: captures.kiri.availability(),
      },
    };
  });

  // Start importing a scan: creates the room and returns where to upload the file, in parts.
  app.post("/rooms/scans", auth, async (req, reply) => {
    const body = parseBody(CreateScanRequest, req, reply);
    if (!body) return;
    const scans = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.ownerId, me(req)), eq(rooms.kind, "scan")));
    if (scans.length >= MAX_SCAN_ROOMS) {
      return sendError(
        reply,
        409,
        "room_limit",
        `You can have up to ${MAX_SCAN_ROOMS} scanned rooms. Delete one to add another.`,
      );
    }
    const format = body.fileName.toLowerCase().endsWith(".ply") ? "ply" : "spz";
    const roomId = `rm_${randomUUID()}`;
    const sourceKey = roomKeys(roomId).source(format);
    const { uploadId } = await storage.createUpload(sourceKey, "application/octet-stream");
    const [room] = await db
      .insert(rooms)
      .values({ id: roomId, ownerId: me(req), name: body.name, kind: "scan", status: "uploading" })
      .returning();
    const options: JobOptions = { format };
    await db.insert(captureJobs).values({
      id: `cj_${randomUUID()}`,
      roomId,
      source: "splat_upload",
      provider: "byo",
      sourceKey,
      uploadId,
      sourceBytes: body.size,
      status: "uploading",
      options,
    });
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
    const partCount = Math.ceil(body.size / UPLOAD_PART_BYTES);
    const parts = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await storage.signUploadPart(sourceKey, uploadId, partNumber, expiresAt);
      parts.push({ partNumber, url });
    }
    changed(me(req));
    const response: CreateScanResponse = {
      room: roomInfo(room!),
      upload: { partSize: UPLOAD_PART_BYTES, parts, expiresAt: expiresAt.toISOString() },
    };
    return reply.code(201).send(response);
  });

  // Every part is uploaded: assemble the file and start post-processing.
  app.post<IdParams>("/rooms/:id/upload/complete", auth, async (req, reply) => {
    const body = parseBody(CompleteUploadRequest, req, reply);
    if (!body) return;
    const room = await ownRoom(req.params.id, me(req));
    if (!room) return sendError(reply, 404, "not_found", "No such room.");
    const [job] = await db
      .select()
      .from(captureJobs)
      .where(and(eq(captureJobs.roomId, room.id), eq(captureJobs.status, "uploading")));
    if (!job?.uploadId) {
      return sendError(reply, 409, "not_uploading", "This room isn't waiting for an upload.");
    }
    const expected = Math.ceil((job.sourceBytes ?? 0) / UPLOAD_PART_BYTES);
    const numbers = new Set(body.parts.map((p) => p.partNumber));
    if (numbers.size !== expected || [...numbers].some((n) => n > expected)) {
      return sendError(reply, 400, "incomplete_upload", "Some parts of the file are missing.");
    }
    try {
      await storage.completeUpload(job.sourceKey, job.uploadId, body.parts);
    } catch (err) {
      req.log.warn({ err }, "completing upload failed");
      return sendError(reply, 400, "incomplete_upload", "Some parts of the file are missing.");
    }
    const size = await storage.size(job.sourceKey);
    if (size !== job.sourceBytes) {
      await storage.deletePrefix(roomKeys(room.id).prefix);
      await db
        .update(rooms)
        .set({ status: "failed", error: "The upload was incomplete. Try again." })
        .where(eq(rooms.id, room.id));
      await db
        .update(captureJobs)
        .set({ status: "failed", uploadId: null, error: "size mismatch" })
        .where(eq(captureJobs.id, job.id));
      changed(me(req));
      return sendError(reply, 400, "incomplete_upload", "The upload was incomplete. Try again.");
    }
    await db
      .update(captureJobs)
      .set({ status: "queued", uploadId: null })
      .where(eq(captureJobs.id, job.id));
    const [updated] = await db
      .update(rooms)
      .set({ status: "processing", progress: 0, error: null })
      .where(eq(rooms.id, room.id))
      .returning();
    captures.enqueue(job.id);
    changed(me(req));
    return roomInfo(updated!);
  });

  // Rename, fix the scale ("how tall is this room?"), or say which way is up.
  app.patch<IdParams>("/rooms/:id", auth, async (req, reply) => {
    const body = parseBody(UpdateRoomRequest, req, reply);
    if (!body) return;
    const room = await ownRoom(req.params.id, me(req));
    if (!room) return sendError(reply, 404, "not_found", "No such room.");
    if ((body.heightMeters !== undefined || body.up !== undefined) && room.kind !== "scan") {
      return sendError(reply, 400, "not_a_scan", "Only scanned rooms can be adjusted.");
    }
    if ((body.heightMeters !== undefined || body.up !== undefined) && room.status !== "ready") {
      return sendError(reply, 409, "not_ready", "Wait until the room has finished processing.");
    }
    if (body.name !== undefined) {
      await db.update(rooms).set({ name: body.name }).where(eq(rooms.id, room.id));
    }
    const details = ScanDetails.safeParse(room.scan);
    if (body.up !== undefined && details.success) {
      // A different up axis means a different floor and walls: process the scan again.
      const options: JobOptions = {
        format: details.data.format,
        up: body.up,
        ...(body.heightMeters !== undefined && { heightMeters: body.heightMeters }),
      };
      const jobId = `cj_${randomUUID()}`;
      await db.insert(captureJobs).values({
        id: jobId,
        roomId: room.id,
        source: "splat_upload",
        provider: "byo",
        sourceKey: roomKeys(room.id).source(details.data.format),
        status: "queued",
        options,
      });
      await db
        .update(rooms)
        .set({ status: "processing", progress: 0, error: null })
        .where(eq(rooms.id, room.id));
      captures.enqueue(jobId);
    } else if (body.heightMeters !== undefined && room.manifestKey && details.success) {
      const result = await rescaleRoom(storage, room.manifestKey, body.heightMeters, details.data);
      await db.update(rooms).set({ scan: result.details }).where(eq(rooms.id, room.id));
    }
    changed(me(req));
    const updated = await ownRoom(room.id, me(req));
    return roomInfo(updated!) satisfies RoomInfo;
  });

  // Deleting a room deletes its files. A gathering in it ends first.
  app.delete<IdParams>("/rooms/:id", auth, async (req, reply) => {
    const room = await ownRoom(req.params.id, me(req));
    if (!room) return sendError(reply, 404, "not_found", "No such room.");
    if (room.kind === "sample") {
      return sendError(reply, 400, "sample_room", "The sample room can't be deleted.");
    }
    const inRoom = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.roomId, room.id), eq(sessions.status, "live")));
    for (const s of inRoom) await gatherings.end(s.id);
    const uploads = await db
      .select({ sourceKey: captureJobs.sourceKey, uploadId: captureJobs.uploadId })
      .from(captureJobs)
      .where(and(eq(captureJobs.roomId, room.id), inArray(captureJobs.status, ["uploading"])));
    for (const u of uploads) if (u.uploadId) await storage.abortUpload(u.sourceKey, u.uploadId);
    await storage.deletePrefix(roomKeys(room.id).prefix);
    await db.delete(rooms).where(eq(rooms.id, room.id));
    changed(me(req));
    return reply.code(204).send();
  });

  // Recording a video and having it turned into a room needs a capture provider (KIRI Engine).
  app.post("/rooms/videos", auth, async (_req, reply) => {
    const { available, reason } = captures.kiri.availability();
    if (!available) {
      return sendError(reply, 503, "capture_unavailable", reason ?? "Video capture is off.");
    }
    return sendError(reply, 501, "not_implemented", "Video capture isn't built yet.");
  });
}
