// Creates .env from .env.example on first run so `pnpm dev` works out of the box.
import { copyFileSync, existsSync } from "node:fs";

const env = new URL("../.env", import.meta.url);
if (!existsSync(env)) {
  copyFileSync(new URL("../.env.example", import.meta.url), env);
  console.log("Created .env from .env.example");
}
