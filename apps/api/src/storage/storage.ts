import type { Readable } from "node:stream";

/**
 * Object storage for room assets (PLAN.md § 3.1). Two backends behind one interface: the local
 * filesystem for development (`apps/api/.data/storage`, served through HMAC-signed API routes)
 * and any S3-compatible store (R2, SeaweedFS) in production.
 *
 * Browsers never get storage credentials: uploads and downloads go through signed URLs that
 * expire (ADR 0012). Download URLs can be scoped to a live session, which the local backend
 * checks on every request; S3 URLs can only carry an expiry, so those are kept short.
 */
export interface ObjectStorage {
  readonly kind: "fs" | "s3";

  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Streams an object; rejects with `ObjectNotFoundError` if it doesn't exist. */
  stream(key: string): Promise<Readable>;
  /** Size in bytes, or null if there's no such object. */
  size(key: string): Promise<number | null>;
  /** Deletes every object whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;

  /** Multipart upload, so big scans upload in retryable parts straight from the browser. */
  createUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresAt: Date,
  ): Promise<string>;
  completeUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  abortUpload(key: string, uploadId: string): Promise<void>;

  /** A URL a browser can GET until `expiresAt` (and, where supported, while `sessionId` is live). */
  signDownload(key: string, opts: { expiresAt: Date; sessionId?: string }): Promise<string>;
}

export class ObjectNotFoundError extends Error {
  override name = "ObjectNotFoundError";
}

/** Keys are ours (never user input), but keep them boring so they're safe as paths and URLs. */
export function assertSafeKey(key: string) {
  if (!/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_.-]+)*$/.test(key) || key.split("/").includes("..")) {
    throw new Error(`unsafe storage key: ${key}`);
  }
}
