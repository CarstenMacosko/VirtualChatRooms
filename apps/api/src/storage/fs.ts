import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSafeKey, ObjectNotFoundError, type ObjectStorage } from "./storage";

/** URL prefixes the API serves for this backend (see routes/storage.ts). */
export const FS_OBJECT_ROUTE = "/storage/o/";
export const FS_UPLOAD_ROUTE = "/storage/u/";

export interface SignedQuery {
  exp?: string;
  ses?: string;
  sig?: string;
}

export class PartTooLargeError extends Error {
  override name = "PartTooLargeError";
}

/**
 * Development storage on the local disk. Objects live under `<root>/objects/<key>`; multipart
 * uploads collect their parts under `<root>/uploads/<uploadId>/` until completed. Signed URLs
 * are API routes with an HMAC over the path, expiry and (for downloads) the session id.
 */
export class FsStorage implements ObjectStorage {
  readonly kind = "fs";
  private readonly key: Buffer;

  constructor(
    private readonly root: string,
    secret: string,
  ) {
    // A key of its own, so a storage signature can never be mistaken for anything else.
    this.key = createHmac("sha256", secret).update("vcr-storage-v1").digest();
  }

  private objectPath(key: string) {
    assertSafeKey(key);
    return join(this.root, "objects", key);
  }

  private uploadDir(uploadId: string) {
    if (!/^[a-f0-9]{32}$/.test(uploadId)) throw new ObjectNotFoundError("no such upload");
    return join(this.root, "uploads", uploadId);
  }

  async put(key: string, body: Buffer | string, _contentType?: string) {
    const path = this.objectPath(key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so readers never see half a file.
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async get(key: string) {
    try {
      return await readFile(this.objectPath(key));
    } catch (err) {
      throw notFound(err, key);
    }
  }

  async stream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const path = this.objectPath(key);
    if ((await this.size(key)) === null) throw new ObjectNotFoundError(key);
    return createReadStream(path, range);
  }

  async size(key: string) {
    try {
      const s = await stat(this.objectPath(key));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }

  async deletePrefix(prefix: string) {
    assertSafeKey(prefix.replace(/\/$/, ""));
    const base = join(this.root, "objects", prefix);
    if (prefix.endsWith("/")) {
      await rm(base, { recursive: true, force: true });
      return;
    }
    // A key prefix that isn't a directory: delete matching siblings.
    const dir = dirname(base);
    const name = base.slice(dir.length + 1);
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((e) => e.startsWith(name))
        .map((e) => rm(join(dir, e), { recursive: true, force: true })),
    );
  }

  async createUpload(key: string, contentType: string) {
    assertSafeKey(key);
    const uploadId = randomBytes(16).toString("hex");
    const dir = this.uploadDir(uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "upload.json"), JSON.stringify({ key, contentType }));
    return { uploadId };
  }

  async signUploadPart(_key: string, uploadId: string, partNumber: number, expiresAt: Date) {
    const path = `${FS_UPLOAD_ROUTE}${uploadId}/${partNumber}`;
    return this.signedPath(path, expiresAt);
  }

  /** Stores one part from a request body; returns its ETag (MD5, like S3). */
  async writePart(uploadId: string, partNumber: number, body: Readable, maxBytes: number) {
    const dir = this.uploadDir(uploadId);
    if (!(await stat(dir).catch(() => null))) throw new ObjectNotFoundError("no such upload");
    const md5 = createHash("md5");
    let bytes = 0;
    const tmp = join(dir, `${partNumber}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new PartTooLargeError("part too large");
            md5.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const etag = `"${md5.digest("hex")}"`;
    await rename(tmp, join(dir, `${partNumber}.part`));
    await writeFile(join(dir, `${partNumber}.etag`), etag);
    return etag;
  }

  async completeUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ) {
    const dir = this.uploadDir(uploadId);
    const meta = JSON.parse(await readFile(join(dir, "upload.json"), "utf8").catch(() => "{}"));
    if (meta.key !== key) throw new ObjectNotFoundError("no such upload");
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const part of sorted) {
      const etag = await readFile(join(dir, `${part.partNumber}.etag`), "utf8").catch(() => null);
      if (etag === null || unquote(etag) !== unquote(part.etag)) {
        throw new ObjectNotFoundError(`part ${part.partNumber} is missing`);
      }
    }
    const path = this.objectPath(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    const out = createWriteStream(tmp);
    try {
      for (const part of sorted) {
        await pipeline(createReadStream(join(dir, `${part.partNumber}.part`)), out, {
          end: false,
        });
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    } catch (err) {
      out.destroy();
      await rm(tmp, { force: true });
      throw err;
    }
    await rename(tmp, path);
    await rm(dir, { recursive: true, force: true });
  }

  async abortUpload(_key: string, uploadId: string) {
    await rm(this.uploadDir(uploadId), { recursive: true, force: true });
  }

  async signDownload(key: string, opts: { expiresAt: Date; sessionId?: string }) {
    assertSafeKey(key);
    return this.signedPath(`${FS_OBJECT_ROUTE}${key}`, opts.expiresAt, opts.sessionId);
  }

  /**
   * Checks a signed path. Returns the session the URL is scoped to ("" for none), or null when
   * the signature is wrong or expired.
   */
  verify(path: string, query: SignedQuery, now = Date.now()): { sessionId: string } | null {
    const exp = Number(query.exp);
    if (!Number.isFinite(exp) || exp * 1000 < now || typeof query.sig !== "string") return null;
    const expected = this.signature(path, exp, query.ses ?? "");
    const given = Buffer.from(query.sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return { sessionId: query.ses ?? "" };
  }

  private signature(path: string, exp: number, sessionId: string) {
    return createHmac("sha256", this.key).update(`${path}\n${exp}\n${sessionId}`).digest();
  }

  private signedPath(path: string, expiresAt: Date, sessionId = "") {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = this.signature(path, exp, sessionId).toString("base64url");
    const query = new URLSearchParams({
      exp: String(exp),
      ...(sessionId && { ses: sessionId }),
      sig,
    });
    return `${path}?${query}`;
  }
}

const unquote = (etag: string) => etag.trim().replace(/^"|"$/g, "");

function notFound(err: unknown, key: string) {
  return (err as { code?: string }).code === "ENOENT" ? new ObjectNotFoundError(key) : err;
}
