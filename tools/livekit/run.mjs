// Starts `livekit-server --dev` for local development (API key "devkey", secret "secret", the
// defaults in .env.example). If .env points at LiveKit Cloud, if livekit-server isn't installed,
// or if something already listens on its port, this says so and idles, so the rest of
// `pnpm dev` keeps running.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

const PORT = 7880;
const idle = (message) => {
  console.log(message);
  setInterval(() => {}, 1 << 30);
};

const portInUse = () =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const installed = spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;

// With LiveKit Cloud (or any non-local server) in .env, there's nothing to run here.
let configuredUrl = process.env.LIVEKIT_URL ?? "";
try {
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  configuredUrl = env.match(/^LIVEKIT_URL=(.*)$/m)?.[1]?.trim() ?? configuredUrl;
} catch {
  // no .env: the realm's default (local) applies
}
const remote = configuredUrl !== "" && !/localhost|127\.0\.0\.1/.test(configuredUrl);

if (remote) {
  idle(`[livekit] using ${configuredUrl}; not starting a local server`);
} else if (await portInUse()) {
  idle(`[livekit] something is already listening on ${PORT}; using it`);
} else if (!installed) {
  idle(
    "[livekit] livekit-server isn't installed, so voice and video are off.\n" +
      "[livekit] Install it with `brew install livekit` (macOS) or see https://docs.livekit.io/home/self-hosting/local/",
  );
} else {
  const child = spawn("livekit-server", ["--dev", "--bind", "127.0.0.1"], { stdio: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("exit", (code) => process.exit(code ?? 0));
}
