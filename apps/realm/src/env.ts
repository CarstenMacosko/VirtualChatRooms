import { z } from "zod";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file: fall back to the process environment and the defaults below.
}

const Env = z.object({
  REALM_PORT: z.coerce.number().int().positive().default(2567),
  SESSION_TOKEN_SECRET: z.string().min(32),
});

export const env = Env.parse(process.env);
