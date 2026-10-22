import type { FastifyInstance } from "fastify";
import { AccessToken } from "livekit-server-sdk";
import { type ApiError, MediaTokenRequest, type MediaTokenResponse } from "@vcr/protocol";
import type { AppContext } from "../app";
import { requireSession } from "../auth";

const TOKEN_TTL_SECONDS = 2 * 60 * 60;

export function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  const { env } = ctx;

  // Phase 0 grants any signed-in user any room. Phase 2 limits this to live sessions the user
  // was invited to (PLAN.md § 4.4).
  app.post(
    "/media/token",
    { preHandler: requireSession(env.SESSION_TOKEN_SECRET) },
    async (req, reply) => {
      const body = MediaTokenRequest.safeParse(req.body);
      if (!body.success) {
        const error: ApiError = { error: "invalid_request", message: body.error.message };
        return reply.code(400).send(error);
      }
      const session = req.session!;
      const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: session.sub,
        name: session.name,
        ttl: TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        roomJoin: true,
        room: body.data.room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      const response: MediaTokenResponse = {
        url: env.LIVEKIT_URL,
        token: await at.toJwt(),
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      };
      return response;
    },
  );
}
