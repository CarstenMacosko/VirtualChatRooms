import { fileURLToPath } from "node:url";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /** Empty means "use embedded PGlite", so the API runs without Docker. */
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  PGLITE_DIR: z.string().default(fileURLToPath(new URL("../.data/pglite", import.meta.url))),
  SESSION_TOKEN_SECRET: z.string().min(32),
  /** Clerk (real accounts). Empty: only the development sign-in is available. */
  CLERK_SECRET_KEY: z.string().default(""),
  /** Optional: Clerk's JWT public key (PEM), to verify sessions without fetching keys. */
  CLERK_JWT_KEY: z.string().default(""),
  /** Where `pnpm share` writes the current public link (read by `GET /dev/share`). */
  SHARE_URL_FILE: z
    .string()
    .default(fileURLToPath(new URL("../../../.share-url", import.meta.url))),
  /** Lets the name-only development sign-in work through `pnpm share`. Unsafe; tests only. */
  ALLOW_REMOTE_DEV_LOGIN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  /** Web Push (calls while the app is closed). Empty disables push; `pnpm dev` generates a pair. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:dev@localhost"),
  /** Room assets: "fs" keeps them under STORAGE_DIR; "s3" uses the S3_* bucket (R2, SeaweedFS). */
  STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  STORAGE_DIR: z.string().default(fileURLToPath(new URL("../.data/storage", import.meta.url))),
  S3_ENDPOINT: z.string().default(""),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
  /** KIRI Engine (video → room). Without it, only importing existing scans works. */
  KIRI_API_KEY: z.string().default(""),
});
export type Env = z.infer<typeof Env>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return Env.parse(source);
}

export function loadEnv(): Env {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // No .env file: fall back to the process environment and the defaults above.
  }
  return parseEnv(process.env);
}
