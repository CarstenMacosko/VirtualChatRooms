import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { ApiError } from "@vcr/protocol";

export function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  const body: ApiError = { error, message };
  return reply.code(status).send(body);
}

/** Parses the request body, or sends a 400 and returns null. */
export function parseBody<S extends z.ZodType>(
  schema: S,
  req: FastifyRequest,
  reply: FastifyReply,
): z.infer<S> | null {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  void sendError(reply, 400, "invalid_request", result.error.message);
  return null;
}

export type IdParams = { Params: { id: string } };
