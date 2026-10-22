import { buildApp } from "./app";
import { createDatabase } from "./db/client";
import { loadEnv } from "./env";

const env = loadEnv();
const database = await createDatabase({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
const app = await buildApp({ db: database.db, dbKind: database.kind, env });

const shutdown = async () => {
  await app.close();
  await database.close(); // PGlite must close cleanly or its data directory can be left corrupt
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: env.API_HOST, port: env.API_PORT });
app.log.info(`database: ${database.kind}`);
