import type { FastifyInstance } from "fastify";
import type { Services } from "../app";
import { requireSession } from "../auth";

const HEARTBEAT_MS = 25_000;

/**
 * `GET /events`: a server-sent event stream of LiveEvents for the signed-in user. The web client
 * reads it with fetch (not EventSource) so it can send the Authorization header.
 */
export function eventRoutes(app: FastifyInstance, ctx: Services) {
  const { env, live } = ctx;

  app.get("/events", { preHandler: requireSession(env.SESSION_TOKEN_SECRET) }, (req, reply) => {
    const userId = req.session!.sub;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // CORS headers set by @fastify/cors
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n: connected\n\n");

    const detach = live.attach(userId, res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const close = () => {
      clearInterval(heartbeat);
      detach();
    };
    req.raw.on("close", close);
    res.on("close", close);
  });
}
