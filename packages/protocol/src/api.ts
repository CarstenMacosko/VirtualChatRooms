import { z } from "zod";

/** REST contracts between the web client and apps/api. */

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  service: z.literal("api"),
  database: z.enum(["postgres", "pglite"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** LiveKit room names and realm session ids share this shape. */
export const SessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const MediaTokenRequest = z.object({
  room: SessionId,
});
export type MediaTokenRequest = z.infer<typeof MediaTokenRequest>;

export const MediaTokenResponse = z.object({
  url: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});
export type MediaTokenResponse = z.infer<typeof MediaTokenResponse>;
