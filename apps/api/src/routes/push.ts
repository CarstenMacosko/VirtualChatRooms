import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PushSubscriptionRequest, type VapidKeyResponse } from "@vcr/protocol";
import type { Services } from "../app";
import { requireSession } from "../auth";
import { pushSubscriptions } from "../db/schema";
import { parseBody } from "../http";

export function pushRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, push } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };

  app.get("/push/vapid-key", async (): Promise<VapidKeyResponse> => {
    return { publicKey: push.enabled ? env.VAPID_PUBLIC_KEY : null };
  });

  // Upsert: a browser re-sends its subscription on every visit, and may move between accounts.
  app.post("/push/subscriptions", auth, async (req, reply) => {
    const body = parseBody(PushSubscriptionRequest, req, reply);
    if (!body) return;
    const row = { userId: req.session!.sub, p256dh: body.keys.p256dh, auth: body.keys.auth };
    await db
      .insert(pushSubscriptions)
      .values({ endpoint: body.endpoint, ...row })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
    return reply.code(204).send();
  });

  app.delete("/push/subscriptions", auth, async (req, reply) => {
    const body = parseBody(z.object({ endpoint: z.string() }), req, reply);
    if (!body) return;
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, body.endpoint),
          eq(pushSubscriptions.userId, req.session!.sub),
        ),
      );
    return reply.code(204).send();
  });
}
