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
  void sendError(reply, 400, "invalid_request", readableIssues(result.error));
  return null;
}

/** The first validation problem as a sentence people can read, not zod's JSON dump. */
export function readableIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request.";
  const field = issue.path.join(".");
  // Custom messages (like the friend code's) already read as sentences.
  return issue.code === "custom" || /^[A-Z]/.test(issue.message) || !field
    ? issue.message
    : `${field}: ${issue.message}`;
}

export type IdParams = { Params: { id: string } };
