import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@vcr/protocol";
import type { AppContext } from "../app";

export function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/health", async (): Promise<HealthResponse> => {
    await ctx.db.execute(sql`select 1`);
    return { ok: true, service: "api", database: ctx.dbKind };
  });
}
