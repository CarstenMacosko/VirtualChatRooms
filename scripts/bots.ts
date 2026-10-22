/**
 * Load/feel test: N bots join a live gathering as guests and wander the sample room, sending poses
 * at the same rates a real client does (through the realm relay, since bots don't use LiveKit).
 * Start a gathering in the web app, click Invite → Copy guest link, then:
 *
 *   pnpm bots 10 <guest link>       # 10 bots for 2 minutes
 *   pnpm bots 24 <guest link> 300   # 24 bots for 5 minutes (25 people with you)
 */
import { Client, type Room } from "@colyseus/sdk";
import { PoseSender, SAMPLE_ROOM } from "@vcr/engine";
import { JoinSessionResponse, LocoState, REALM_ROOM_NAME, RealmMessage } from "@vcr/protocol";

const count = Number(process.argv[2] ?? 10);
// Accepts the whole link (http://localhost:5173/join/<token>) or just the token.
const guestToken = process.argv[3]?.split("/").filter(Boolean).at(-1);
const seconds = Number(process.argv[4] ?? 120);
if (!guestToken) {
  console.error("Usage: pnpm bots <count> <guest link> [seconds]");
  process.exit(1);
}
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
  const res = await fetch(`${API}/guest/${guestToken}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: `Bot ${i + 1}` }),
  });
  if (!res.ok) throw new Error(`guest join failed (${res.status}): ${await res.text()}`);
  const { realmTicket, sessionId } = JoinSessionResponse.parse(await res.json());
  const room = await new Client(REALM).joinOrCreate(REALM_ROOM_NAME, {
    ticket: realmTicket,
    sessionId,
  });
  for (const type of [
    RealmMessage.pose,
    RealmMessage.emote,
    RealmMessage.media,
    RealmMessage.notice,
  ]) {
    room.onMessage(type, () => {});
  }
  room.onLeave((code) => {
    console.log(`Bot ${i + 1} left (code ${code})`);
  });
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
console.log(`${bots.length} bots walking around for ${seconds}s`);

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
