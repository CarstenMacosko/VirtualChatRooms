import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Database, DatabaseHandle } from "./db/client";
import type { Env } from "./env";
import { Gatherings } from "./gatherings";
import { LiveHub } from "./live";
import { authRoutes } from "./routes/auth";
import { contactRoutes } from "./routes/contacts";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { sessionRoutes } from "./routes/sessions";
import { acceptedContactIds } from "./social";

export interface AppContext {
  db: Database;
  dbKind: DatabaseHandle["kind"];
  env: Env;
  /** Overrides RING_TIMEOUT_MS, for tests. */
  ringTimeoutMs?: number;
}

/** What route modules get: the app context plus the in-process services built on it. */
export interface Services extends AppContext {
  live: LiveHub;
  gatherings: Gatherings;
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
  const gatherings = new Gatherings(ctx.db, live, ctx.ringTimeoutMs);
  await gatherings.expireStaleRings();
  const services: Services = { ...ctx, live, gatherings };

  // Contacts see each other come online and go offline.
  live.onPresenceChange((userId) => {
    void acceptedContactIds(ctx.db, userId)
      .then((ids) => live.sendMany(ids, { type: "contacts-changed" }))
      .catch((err: unknown) => app.log.warn({ err }, "presence fan-out failed"));
  });

  app.addHook("onClose", async () => {
    live.closeAll();
    gatherings.dispose();
  });

  healthRoutes(app, services);
  authRoutes(app, services);
  contactRoutes(app, services);
  sessionRoutes(app, services);
  eventRoutes(app, services);

  return app;
}
