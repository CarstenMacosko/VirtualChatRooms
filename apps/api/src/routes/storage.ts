import { extname } from "node:path";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { UPLOAD_PART_BYTES } from "@vcr/protocol";
import type { Services } from "../app";
import { sessions } from "../db/schema";
import { sendError } from "../http";
import {
  FS_OBJECT_ROUTE,
  FS_UPLOAD_ROUTE,
  FsStorage,
  PartTooLargeError,
  type SignedQuery,
} from "../storage/fs";
import { ObjectNotFoundError } from "../storage";

type ObjectRequest = { Params: { "*": string }; Querystring: SignedQuery };
type PartRequest = {
  Params: { uploadId: string; part: string };
  Querystring: SignedQuery;
  Body: Readable;
};

const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
};

/**
 * The local storage backend's signed URLs (S3 serves its own). Downloads scoped to a session
 * stop working as soon as that session ends (ADR 0012), not just when the URL expires.
 */
export function storageRoutes(app: FastifyInstance, ctx: Services) {
  const { storage, db } = ctx;
  if (!(storage instanceof FsStorage)) return;

  void app.register(async (scoped) => {
    // Part uploads are raw bytes of any type; hand the stream over unparsed.
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    scoped.put<PartRequest>(`${FS_UPLOAD_ROUTE}:uploadId/:part`, async (req, reply) => {
      const { uploadId, part } = req.params;
      if (!storage.verify(`${FS_UPLOAD_ROUTE}${uploadId}/${part}`, req.query)) {
        return sendError(reply, 403, "forbidden", "This upload link has expired.");
      }
      try {
        const etag = await storage.writePart(uploadId, Number(part), req.body, UPLOAD_PART_BYTES);
        return reply.header("etag", etag).code(200).send();
      } catch (err) {
        if (err instanceof PartTooLargeError) {
          return sendError(reply, 413, "too_large", "That part is too large.");
        }
        if (err instanceof ObjectNotFoundError) {
          return sendError(reply, 404, "not_found", "No such upload.");
        }
        throw err;
      }
    });
  });

  app.get<ObjectRequest>(`${FS_OBJECT_ROUTE}*`, async (req, reply) => {
    const key = req.params["*"];
    const grant = storage.verify(`${FS_OBJECT_ROUTE}${key}`, req.query);
    if (!grant) return sendError(reply, 403, "forbidden", "This link has expired.");
    if (grant.sessionId) {
      const [live] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, grant.sessionId), eq(sessions.status, "live")));
      if (!live) return sendError(reply, 403, "forbidden", "This gathering has ended.");
    }
    const size = await storage.size(key);
    if (size === null) return sendError(reply, 404, "not_found", "No such file.");

    reply
      .header("content-type", CONTENT_TYPES[extname(key)] ?? "application/octet-stream")
      .header("accept-ranges", "bytes")
      .header("cache-control", "private, max-age=3600");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(await storage.stream(key, { start, end }));
    }
    return reply.header("content-length", size).send(await storage.stream(key));
  });
}
