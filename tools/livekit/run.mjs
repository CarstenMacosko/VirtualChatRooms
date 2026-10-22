// Starts `livekit-server --dev` for local development (API key "devkey", secret "secret", the
// defaults in .env.example). If it isn't installed, or something already listens on its port,
// this says so and idles, so the rest of `pnpm dev` keeps running without voice and video.
import { spawn, spawnSync } from "node:child_process";
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

if (await portInUse()) {
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
