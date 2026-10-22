import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Database, DatabaseHandle } from "./db/client";
import type { Env } from "./env";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { mediaRoutes } from "./routes/media";

export interface AppContext {
  db: Database;
  dbKind: DatabaseHandle["kind"];
  env: Env;
}

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: ctx.env.NODE_ENV === "test" ? false : { level: "info" },
  });
  app.decorateRequest("session", null);
  await app.register(cors, { origin: ctx.env.WEB_ORIGIN });

  healthRoutes(app, ctx);
  authRoutes(app, ctx);
  mediaRoutes(app, ctx);

  return app;
}
