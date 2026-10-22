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
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  /** Web Push (calls while the app is closed). Empty disables push; `pnpm dev` generates a pair. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:dev@localhost"),
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
