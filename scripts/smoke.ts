/**
 * End-to-end check against running servers (`pnpm dev` in another terminal):
 * API health → age gate → sign-in → /me → media token → two clients join the same realm
 * session, see each other, and receive an emote.
 */
import { Client } from "@colyseus/sdk";
import {
  decodePose,
  decodeRelayedPose,
  DevLoginResponse,
  encodePose,
  LocoState,
  type EmoteBroadcast,
  HealthResponse,
  MediaTokenResponse,
  REALM_ROOM_NAME,
  RealmMessage,
} from "@vcr/protocol";

const API = process.env.SMOKE_API_URL ?? "http://127.0.0.1:3001";
const REALM = process.env.SMOKE_REALM_URL ?? "ws://127.0.0.1:2567";
const SESSION = `smoke-${Date.now()}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function post(path: string, body: unknown, token?: string) {
  return fetch(API + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

const health = HealthResponse.parse(await (await fetch(API + "/health")).json());
check("API health", health.ok, `database: ${health.database}`);

const kid = await post("/auth/dev-login", { displayName: "Smoke Kid", birthDate: "2020-01-01" });
check("age gate blocks under-13 sign-up", kid.status === 403);

const alice = DevLoginResponse.parse(
  await (
    await post("/auth/dev-login", { displayName: "Smoke Alice", birthDate: "1985-03-02" })
  ).json(),
);
const bob = DevLoginResponse.parse(
  await (
    await post("/auth/dev-login", { displayName: "Smoke Bob", birthDate: "1962-11-30" })
  ).json(),
);
check("dev sign-in", alice.token.length > 0 && bob.user.id !== alice.user.id);

const me = await fetch(API + "/me", { headers: { authorization: `Bearer ${alice.token}` } });
check("/me with session token", me.ok);

const media = MediaTokenResponse.parse(
  await (await post("/media/token", { room: SESSION }, alice.token)).json(),
);
check("LiveKit token minted", media.token.split(".").length === 3, media.url);

const client = new Client(REALM);
const roomA = await withTimeout(
  client.joinOrCreate(REALM_ROOM_NAME, { token: alice.token, sessionId: SESSION }),
  5000,
  "Alice joining realm",
);
const roomB = await withTimeout(
  client.joinOrCreate(REALM_ROOM_NAME, { token: bob.token, sessionId: SESSION }),
  5000,
  "Bob joining realm",
);
check("both clients land in the same session room", roomA.roomId === roomB.roomId);

type Synced = { participants: Record<string, { name: string; role: string }> };
const seesBoth = await withTimeout(
  new Promise<Synced>((resolve) => {
    const onState = (state: unknown) => {
      const json = (state as { toJSON(): Synced }).toJSON();
      // State is empty until the first patch arrives.
      if (Object.keys(json.participants ?? {}).length === 2) resolve(json);
    };
    roomB.onStateChange(onState);
    onState(roomB.state);
  }),
  5000,
  "roster sync",
);
const roles = Object.values(seesBoth.participants)
  .map((p) => `${p.name}:${p.role}`)
  .sort();
check(
  "roster syncs with roles",
  roles.join(",") === "Smoke Alice:owner,Smoke Bob:member",
  roles.join(", "),
);

const emote = withTimeout(
  new Promise<EmoteBroadcast>((resolve) => roomB.onMessage(RealmMessage.emote, resolve)),
  5000,
  "emote broadcast",
);
roomA.onMessage(RealmMessage.emote, () => {}); // the sender receives its own broadcast too
roomA.send(RealmMessage.emote, { emote: "wave" });
const received = await emote;
check(
  "emote broadcast reaches others",
  received.emote === "wave" && received.from === roomA.sessionId,
);

const relayed = withTimeout(
  new Promise<Uint8Array>((resolve) => roomB.onMessage(RealmMessage.pose, resolve)),
  5000,
  "pose relay",
);
roomA.sendBytes(
  RealmMessage.pose,
  encodePose({ seq: 1, t: 42, position: [1.5, 0, -0.5], yaw: 1, loco: LocoState.walk }),
);
const { from, pose } = decodeRelayedPose(await relayed);
check(
  "pose relayed to others with the sender's id",
  from === roomA.sessionId && decodePose(pose).position[0] === 1.5,
);

const rejected = await client
  .joinOrCreate(REALM_ROOM_NAME, { token: "not-a-token", sessionId: SESSION })
  .then(() => false)
  .catch(() => true);
check("realm rejects invalid session tokens", rejected);

await roomA.leave();
await roomB.leave();

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
