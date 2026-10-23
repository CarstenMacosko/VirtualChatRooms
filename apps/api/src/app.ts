import cors from "@fastify/cors";
import Fastify from "fastify";
import { Captures } from "./captures";
import type { Database, DatabaseHandle } from "./db/client";
import type { Env } from "./env";
import { Gatherings } from "./gatherings";
import { identityFromEnv, type IdentityProvider } from "./identity";
import { LiveHub } from "./live";
import { PushNotifier, type PushSender } from "./push";
import { authRoutes } from "./routes/auth";
import { avatarRoutes } from "./routes/avatar";
import { contactRoutes } from "./routes/contacts";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { pushRoutes } from "./routes/push";
import { roomRoutes } from "./routes/rooms";
import { sessionRoutes } from "./routes/sessions";
import { storageRoutes } from "./routes/storage";
import { acceptedContactIds } from "./social";
import { type ObjectStorage, storageFromEnv } from "./storage";

export interface AppContext {
  db: Database;
  dbKind: DatabaseHandle["kind"];
  env: Env;
  /** Overrides RING_TIMEOUT_MS, for tests. */
  ringTimeoutMs?: number;
  /** Replaces the real Web Push sender, for tests. */
  pushSender?: PushSender;
  /** Replaces the sign-in provider (Clerk, from env), for tests. */
  identity?: IdentityProvider | null;
  /** Replaces object storage (from env), for tests. */
  storage?: ObjectStorage;
}

/** What route modules get: the app context plus the in-process services built on it. */
export interface Services extends AppContext {
  live: LiveHub;
  gatherings: Gatherings;
  push: PushNotifier;
  identity: IdentityProvider | null;
  storage: ObjectStorage;
  captures: Captures;
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
  const identity = ctx.identity === undefined ? identityFromEnv(ctx.env) : ctx.identity;
  const storage = ctx.storage ?? storageFromEnv(ctx.env);
  const captures = new Captures(ctx.db, storage, live, app.log, ctx.env.KIRI_API_KEY);
  await captures.resume();
  const services: Services = { ...ctx, live, gatherings, push, identity, storage, captures };

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
    captures.dispose();
    await captures.idle();
  });

  healthRoutes(app, services);
  authRoutes(app, services);
  avatarRoutes(app, services);
  contactRoutes(app, services);
  roomRoutes(app, services);
  storageRoutes(app, services);
  sessionRoutes(app, services);
  eventRoutes(app, services);
  pushRoutes(app, services);

  return app;
}
