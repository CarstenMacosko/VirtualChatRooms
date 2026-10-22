/**
 * Load/feel test for Phase 1: N bots join a session and wander the sample room, sending poses at
 * the same rates a real client does. Run alongside `pnpm dev`, then open the web app:
 *
 *   pnpm bots 10            # 10 bots in the "lobby" session for 2 minutes
 *   pnpm bots 25 family 300 # 25 bots in ?session=family for 5 minutes
 */
import { Client, type Room } from "@colyseus/sdk";
import { PoseSender, SAMPLE_ROOM } from "@vcr/engine";
import { DevLoginResponse, LocoState, REALM_ROOM_NAME, RealmMessage } from "@vcr/protocol";

const count = Number(process.argv[2] ?? 10);
const sessionId = process.argv[3] ?? "lobby";
const seconds = Number(process.argv[4] ?? 120);
const API = process.env.BOTS_API_URL ?? "http://127.0.0.1:3001";
const REALM = process.env.BOTS_REALM_URL ?? "ws://127.0.0.1:2567";

// Open floor areas of the sample room (avoiding furniture), as [minX, maxX, minZ, maxZ].
const WALKABLE: [number, number, number, number][] = [
  [-1.6, 3.2, 0.3, 2.5],
  [1.4, 3.2, -1.6, 0.5],
  [-1.8, -0.6, -1.4, 0.3],
];

function randomPoint(): [number, number, number] {
  const [x0, x1, z0, z1] = WALKABLE[Math.floor(Math.random() * WALKABLE.length)]!;
  return [x0 + Math.random() * (x1 - x0), 0, z0 + Math.random() * (z1 - z0)];
}

interface Bot {
  room: Room;
  sender: PoseSender;
  position: [number, number, number];
  yaw: number;
  target: [number, number, number];
  speed: number;
  pauseUntil: number;
}

async function startBot(i: number): Promise<Bot> {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: `Bot ${i + 1}`, birthDate: "1990-01-01" }),
  });
  const { token } = DevLoginResponse.parse(await res.json());
  const room = await new Client(REALM).joinOrCreate(REALM_ROOM_NAME, { token, sessionId });
  room.onMessage(RealmMessage.pose, () => {});
  room.onMessage(RealmMessage.emote, () => {});
  const position = randomPoint();
  return {
    room,
    sender: new PoseSender((bytes) => room.sendBytes(RealmMessage.pose, bytes)),
    position,
    yaw: SAMPLE_ROOM.spawnPoints[0]!.yaw,
    target: randomPoint(),
    speed: Math.random() < 0.3 ? 3.5 : 1.5,
    pauseUntil: 0,
  };
}

const bots = await Promise.all(Array.from({ length: count }, (_, i) => startBot(i)));
console.log(`${bots.length} bots walking in session "${sessionId}" for ${seconds}s`);

let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  for (const bot of bots) {
    const dx = bot.target[0] - bot.position[0];
    const dz = bot.target[2] - bot.position[2];
    const dist = Math.hypot(dx, dz);
    let loco: LocoState = LocoState.idle;
    if (now < bot.pauseUntil) {
      loco = LocoState.idle;
    } else if (dist < 0.1) {
      bot.target = randomPoint();
      bot.speed = Math.random() < 0.3 ? 3.5 : 1.5;
      bot.pauseUntil = now + Math.random() * 3000;
    } else {
      const step = Math.min(dist, bot.speed * dt);
      bot.position = [
        bot.position[0] + (dx / dist) * step,
        0,
        bot.position[2] + (dz / dist) * step,
      ];
      bot.yaw = Math.atan2(dx, dz);
      loco = bot.speed > 3 ? LocoState.run : LocoState.walk;
    }
    bot.sender.update(now, { position: bot.position, yaw: bot.yaw, loco });
  }
}, 1000 / 60);

setTimeout(async () => {
  clearInterval(tick);
  await Promise.all(bots.map((b) => b.room.leave()));
  console.log("bots left");
  process.exit(0);
}, seconds * 1000);
