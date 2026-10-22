import type { z } from "zod";
import { ApiError, DevLoginResponse, HealthResponse, type DevLoginRequest } from "@vcr/protocol";

/** Thin fetch wrapper for apps/api. Vite proxies /api to the API in development. */

const API_BASE = "/api";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ApiError.safeParse(body);
    throw new ApiRequestError(
      res.status,
      error.success ? error.data.error : "http_error",
      error.success ? error.data.message : `Request failed (${res.status})`,
    );
  }
  return schema.parse(body);
}

export const api = {
  health: () => request(HealthResponse, "/health"),
  devLogin: (body: DevLoginRequest) =>
    request(DevLoginResponse, "/auth/dev-login", { method: "POST", body: JSON.stringify(body) }),
};
