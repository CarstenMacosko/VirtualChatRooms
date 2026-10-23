import type { Env } from "../env";
import { FsStorage } from "./fs";
import { S3Storage } from "./s3";
import type { ObjectStorage } from "./storage";

export * from "./storage";
export { FsStorage } from "./fs";
export { S3Storage } from "./s3";

/** Local disk unless `STORAGE_DRIVER=s3` (with the `S3_*` settings). */
export function storageFromEnv(env: Env): ObjectStorage {
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "STORAGE_DRIVER=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
      );
    }
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return new FsStorage(env.STORAGE_DIR, env.SESSION_TOKEN_SECRET);
}
