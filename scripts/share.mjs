// `pnpm share`: puts your running dev server on the internet at a free, temporary
// https://<random>.trycloudflare.com address (a Cloudflare quick tunnel: no account, no domain).
// Friends see your changes live as you make them and can join your gatherings through guest
// links. Stop with Ctrl+C; the address changes every time you start sharing.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const WEB_PORT = 5173;
const shareFile = new URL("../.share-url", import.meta.url);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0) {
  fail(
    "cloudflared isn't installed. On macOS: brew install cloudflared\nThen run pnpm share again.",
  );
}

// Vite listens on "localhost", which may be IPv4 or IPv6 depending on the machine; find which.
const reachable = (host) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port: WEB_PORT });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
const webHost = (await reachable("127.0.0.1"))
  ? "127.0.0.1"
  : (await reachable("::1"))
    ? "[::1]"
    : null;
if (!webHost) {
  fail(`Nothing is running on port ${WEB_PORT}. Start \`pnpm dev\` first, then run pnpm share.`);
}

// Voice and video only reach friends through a LiveKit server they can get to.
let livekitUrl = "";
try {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  livekitUrl = env.match(/^LIVEKIT_URL=(.*)$/m)?.[1]?.trim() ?? "";
} catch {
  // no .env: defaults apply
}
const localMedia = !livekitUrl || /localhost|127\.0\.0\.1/.test(livekitUrl);

const tunnel = spawn(
  "cloudflared",
  // The public Host header is kept, so the API can tell visitors from the host's own browser.
  ["tunnel", "--no-autoupdate", "--url", `http://${webHost}:${WEB_PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let announced = false;
const onOutput = (chunk) => {
  const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || announced) return;
  announced = true;
  writeFileSync(shareFile, `${url}\n`);
  const lines = [
    "",
    `  🌍 Sharing your dev server at ${url}`,
    "",
    "  • Keep using http://localhost:5173 yourself. Guest links you copy (Invite → Copy guest",
    "    link) now point at the public address, so friends can join as guests.",
    "  • Friends see your changes as you make them. The address lasts until you press Ctrl+C.",
    "  • The name-only development sign-in is turned off for visitors. With Clerk keys in",
    "    .env, friends can also create real accounts at the link.",
    ...(localMedia
      ? [
          "",
          "  ⚠️  Voice and video use the LiveKit server on this computer, which friends can't reach.",
          "     For calls with friends, put LiveKit Cloud keys (free tier) in .env and restart",
          "     pnpm dev: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.",
        ]
      : []),
    "",
  ];
  console.log(lines.join("\n"));
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);

const cleanup = () => {
  rmSync(shareFile, { force: true });
};
const stop = () => {
  cleanup();
  tunnel.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
tunnel.once("exit", (code) => {
  cleanup();
  if (!announced) console.error("cloudflared stopped before the tunnel came up.");
  else console.log("Stopped sharing.");
  process.exit(code ?? 0);
});
