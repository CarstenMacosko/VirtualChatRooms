import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeKey, ObjectNotFoundError, type ObjectStorage } from "./storage";

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** SeaweedFS and MinIO want path-style URLs; R2 works either way. */
  forcePathStyle: boolean;
}

/** Presigned S3 URLs can't be revoked when a session ends, so they stay short (ADR 0012). */
const MAX_PRESIGN_SECONDS = 60 * 60;

const secondsUntil = (date: Date) =>
  Math.max(1, Math.min(MAX_PRESIGN_SECONDS, Math.floor((date.getTime() - Date.now()) / 1000)));

/**
 * S3-compatible storage (Cloudflare R2 in production, SeaweedFS from docker-compose locally).
 * Browsers upload parts and download assets with presigned URLs, so the bucket needs CORS that
 * allows PUT and GET from the web origin and exposes the `ETag` header.
 */
export class S3Storage implements ObjectStorage {
  readonly kind = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async put(key: string, body: Buffer | string, contentType: string) {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string) {
    const stream = await this.stream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async stream(key: string): Promise<Readable> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body as Readable;
    } catch (err) {
      throw isMissing(err) ? new ObjectNotFoundError(key) : err;
    }
  }

  async size(key: string) {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? 0;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async createUpload(key: string, contentType: string) {
    assertSafeKey(key);
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error("storage didn't return an upload id");
    return { uploadId: res.UploadId };
  }

  signUploadPart(key: string, uploadId: string, partNumber: number, expiresAt: Date) {
    assertSafeKey(key);
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: secondsUntil(expiresAt) },
    );
  }

  async completeUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ) {
    assertSafeKey(key);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortUpload(key: string, uploadId: string) {
    assertSafeKey(key);
    await this.client
      .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
      .catch(() => {});
  }

  signDownload(key: string, opts: { expiresAt: Date }) {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: secondsUntil(opts.expiresAt),
    });
  }
}

function isMissing(err: unknown) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}
