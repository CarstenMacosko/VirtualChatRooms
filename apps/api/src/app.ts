import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Captures } from "./captures";
import type { Database, DatabaseHandle } from "./db/client";
import type { Env } from "./env";
import { Gatherings } from "./gatherings";
import { identityFromEnv, type IdentityProvider, isWebOrigin } from "./identity";
import { LiveHub } from "./live";
import { PushNotifier, type PushSender } from "./push";
import { authRoutes } from "./routes/auth";
import { avatarRoutes } from "./routes/avatar";
import { contactRoutes } from "./routes/contacts";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { linkRoutes } from "./routes/links";
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
    // The web app calls the API at /api (Vite strips it in development); accept both.
    rewriteUrl: (req) => {
      const url = req.url ?? "/";
      return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")
        ? url.slice(4) || "/"
        : url;
    },
  });
  app.decorateRequest("session", null);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && isWebOrigin(origin, ctx.env)),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    // The realm's client (Colyseus) always sends credentials, and this answers the preflight for
    // /realm too, so a web app on another origin (Cloudflare Pages) can't join a call without it.
    // Sign-in is a bearer token, never a cookie, so this lets no ambient credentials in.
    credentials: true,
  });
  // The realm (Colyseus, forwarded at /realm) echoes back any origin, and CORS above lets refused
  // preflights through to it: turn away browsers from other sites here instead. Requests without
  // an Origin (scripts, the smoke test) carry no browser credentials and pass.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (req.url.startsWith("/realm") && origin && !isWebOrigin(origin, ctx.env)) {
      return reply
        .code(403)
        .send({ error: "forbidden_origin", message: "Not allowed from this site." });
    }
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
  linkRoutes(app, services);
  storageRoutes(app, services);
  sessionRoutes(app, services);
  eventRoutes(app, services);
  pushRoutes(app, services);
  await serveWebApp(app, ctx.env);

  return app;
}

/**
 * Production on one host (ADR 0016's always-on setup): the built web app, the API (at /api, see
 * rewriteUrl) and the realm (forwarded at /realm, WebSockets included) share one origin, like
 * the Vite dev server arranges in development.
 */
async function serveWebApp(app: FastifyInstance, env: AppContext["env"]) {
  if (env.REALM_PROXY_URL) {
    await app.register(proxy, {
      upstream: env.REALM_PROXY_URL,
      prefix: "/realm",
      rewritePrefix: "",
      websocket: true,
    });
  }
  if (!env.WEB_DIST_DIR) return;
  const root = env.WEB_DIST_DIR;
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root} (build the web app first)`);
  }
  await app.register(staticFiles, {
    root,
    wildcard: false,
    // Hashed bundles never change; everything else (index.html, sw.js) must stay fresh.
    setHeaders: (reply, path) => {
      void reply.header(
        "cache-control",
        path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  // Client-side routes (/s/…, /join/…, /call/…) all load the app.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found", message: "Not found." });
  });
}
