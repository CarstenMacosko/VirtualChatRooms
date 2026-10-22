import { z } from "zod";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file: fall back to the process environment and the defaults below.
}

const Env = z.object({
  REALM_PORT: z.coerce.number().int().positive().default(2567),
  SESSION_TOKEN_SECRET: z.string().min(32),
  /** Where the realm reports ended sessions. */
  API_URL: z.string().default("http://127.0.0.1:3001"),
  /** Empty disables voice and video; avatars and poses still work through the realm. */
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_KEY: z.string().default("devkey"),
  LIVEKIT_API_SECRET: z.string().default("secret"),
});

export const env = Env.parse(process.env);
