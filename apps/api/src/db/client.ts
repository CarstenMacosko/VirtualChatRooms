import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Connects to Postgres when `url` is set; otherwise starts embedded PGlite (persisted in
 * `pgliteDir`, or in memory when that's omitted). Runs pending migrations either way.
 */
export async function createDatabase(opts: {
  url?: string | undefined;
  pgliteDir?: string | undefined;
}): Promise<DatabaseHandle> {
  if (opts.url) {
    const client = postgres(opts.url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres({ client, schema });
    await migratePostgres(db, { migrationsFolder });
    return { db, kind: "postgres", close: () => client.end() };
  }

  if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
  const client = new PGlite(opts.pgliteDir);
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder });
  return { db, kind: "pglite", close: () => client.close() };
}
