import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Database, DatabaseHandle } from "./db/client";
import type { Env } from "./env";
import { Gatherings } from "./gatherings";
import { LiveHub } from "./live";
import { PushNotifier, type PushSender } from "./push";
import { authRoutes } from "./routes/auth";
import { contactRoutes } from "./routes/contacts";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { pushRoutes } from "./routes/push";
import { sessionRoutes } from "./routes/sessions";
import { acceptedContactIds } from "./social";

export interface AppContext {
  db: Database;
  dbKind: DatabaseHandle["kind"];
  env: Env;
  /** Overrides RING_TIMEOUT_MS, for tests. */
  ringTimeoutMs?: number;
  /** Replaces the real Web Push sender, for tests. */
  pushSender?: PushSender;
}

/** What route modules get: the app context plus the in-process services built on it. */
export interface Services extends AppContext {
  live: LiveHub;
  gatherings: Gatherings;
  push: PushNotifier;
}

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: ctx.env.NODE_ENV === "test" ? false : { level: "info" },
  });
  app.decorateRequest("session", null);
  await app.register(cors, {
    origin: ctx.env.WEB_ORIGIN,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });

  const live = new LiveHub();
  const push = new PushNotifier(ctx.db, ctx.env, ctx.pushSender);
  const gatherings = new Gatherings(ctx.db, live, push, ctx.ringTimeoutMs);
  await gatherings.expireStaleRings();
  const services: Services = { ...ctx, live, gatherings, push };

  // Contacts see each other come online and go offline.
  live.onPresenceChange((userId) => {
    void acceptedContactIds(ctx.db, userId)
      .then((ids) => live.sendMany(ids, { type: "contacts-changed" }))
      .catch((err: unknown) => app.log.warn({ err }, "presence fan-out failed"));
  });

  // preClose, not onClose: Fastify waits for open connections before onClose runs, and the
  // long-lived /events streams would keep it waiting forever (e.g. hanging a dev restart).
  app.addHook("preClose", async () => {
    live.closeAll();
    gatherings.dispose();
  });

  healthRoutes(app, services);
  authRoutes(app, services);
  contactRoutes(app, services);
  sessionRoutes(app, services);
  eventRoutes(app, services);
  pushRoutes(app, services);

  return app;
}
