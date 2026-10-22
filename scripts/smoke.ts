/**
 * End-to-end check against running servers (`pnpm dev` in another terminal):
 * sign-in and age gate → contacts by friend code → start a gathering that rings a contact over
 * the live event stream → both join the realm with tickets → roster, emotes, pose relay, media
 * grant → host controls (mute, co-host, lock, remove a guest) → ending the gathering.
 */
import { Client, type Room } from "@colyseus/sdk";
import {
  ContactsResponse,
  decodePose,
  decodeRelayedPose,
  DevLoginResponse,
  encodePose,
  type EmoteBroadcast,
  GuestLinkResponse,
  HealthResponse,
  JoinSessionResponse,
  LiveEvent,
  LocoState,
  type MediaGrant,
  MeResponse,
  type Notice,
  REALM_ROOM_NAME,
  RealmCloseCode,
  RealmJoinError,
  RealmMessage,
  RoomsResponse,
  SessionInfo,
} from "@vcr/protocol";

const API = process.env.SMOKE_API_URL ?? "http://127.0.0.1:3001";
const REALM = process.env.SMOKE_REALM_URL ?? "ws://127.0.0.1:2567";
const run = Date.now().toString(36);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

/** Resolves with the first live event of `type` on `token`'s event stream. */
async function nextLiveEvent(token: string, type: LiveEvent["type"]) {
  const controller = new AbortController();
  const res = await fetch(`${API}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const event = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        const parsed = data ? LiveEvent.parse(JSON.parse(data.slice(6))) : null;
        if (parsed?.type === type) {
          controller.abort();
          return parsed;
        }
      }
    }
  })();
  return { event, close: () => controller.abort() };
}

/** Joins the realm and registers handlers before any message can arrive. */
async function joinRealm(ticket: string, sessionId: string) {
  const room = await new Client(REALM).joinOrCreate(REALM_ROOM_NAME, { ticket, sessionId });
  const media = new Promise<MediaGrant>((resolve) => room.onMessage(RealmMessage.media, resolve));
  const notices: Notice[] = [];
  room.onMessage(RealmMessage.notice, (n: Notice) => notices.push(n));
  room.onMessage(RealmMessage.emote, () => {});
  room.onMessage(RealmMessage.pose, () => {});
  const left = new Promise<number>((resolve) => room.onLeave((code) => resolve(code)));
  return { room, media, notices, left };
}

type Synced = {
  participants: Record<string, { name: string; role: string; muted: boolean }>;
  locked: boolean;
};
const synced = (room: Room) => (room.state as { toJSON(): Synced }).toJSON();
function waitForState(room: Room, predicate: (s: Synced) => boolean, what: string) {
  return withTimeout(
    new Promise<Synced>((resolve) => {
      const onState = () => {
        const json = synced(room);
        if (predicate(json)) resolve(json);
      };
      room.onStateChange(onState);
      onState();
    }),
    5000,
    what,
  );
}

// --- API: health, sign-in, contacts ---

const health = HealthResponse.parse(await (await fetch(API + "/health")).json());
check("API health", health.ok, `database: ${health.database}`);

const kid = await call("POST", "/auth/dev-login", undefined, {
  displayName: "Smoke Kid",
  birthDate: "2020-01-01",
});
check("age gate blocks under-13 sign-up", kid.status === 403);

const signIn = async (displayName: string) =>
  DevLoginResponse.parse(
    await (
      await call("POST", "/auth/dev-login", undefined, { displayName, birthDate: "1980-03-02" })
    ).json(),
  );
const alice = await signIn(`Smoke Alice ${run}`);
const bob = await signIn(`Smoke Bob ${run}`);
check("dev sign-in", alice.token.length > 0 && bob.user.id !== alice.user.id);

const bobMe = MeResponse.parse(await (await call("GET", "/me", bob.token)).json());
check("/me includes a friend code", /^[2-9A-Z]{8}$/.test(bobMe.friendCode), bobMe.friendCode);

await call("POST", "/contacts", alice.token, { friendCode: bobMe.friendCode });
const accepted = ContactsResponse.parse(
  await (await call("POST", `/contacts/${alice.user.id}/accept`, bob.token)).json(),
);
check(
  "contact request by friend code, accepted",
  accepted.contacts.some((c) => c.userId === alice.user.id),
);

// --- Start a gathering; Bob's phone rings ---

const ringing = await nextLiveEvent(bob.token, "ring");
const { rooms } = RoomsResponse.parse(await (await call("GET", "/rooms", alice.token)).json());
const session = SessionInfo.parse(
  await (
    await call("POST", "/sessions", alice.token, {
      roomId: rooms[0]!.id,
      inviteUserIds: [bob.user.id],
    })
  ).json(),
);
check("gathering started", session.status === "live", session.id);
const ring = await withTimeout(ringing.event, 5000, "ring event");
check(
  "invitee is rung over the live event stream",
  ring.type === "ring" && ring.sessionId === session.id,
);

const ticketFor = async (token: string) =>
  JoinSessionResponse.parse(
    await (await call("POST", `/sessions/${session.id}/join`, token)).json(),
  );
const aliceJoin = await ticketFor(alice.token);
const bobJoin = await ticketFor(bob.token);
check("API issues tickets with roles", aliceJoin.role === "owner" && bobJoin.role === "member");

// --- Realm ---

const a = await withTimeout(joinRealm(aliceJoin.realmTicket, session.id), 5000, "Alice joining");
const b = await withTimeout(joinRealm(bobJoin.realmTicket, session.id), 5000, "Bob joining");
check("both clients land in the same session room", a.room.roomId === b.room.roomId);

const roster = await waitForState(
  b.room,
  (s) => Object.keys(s.participants ?? {}).length === 2,
  "roster sync",
);
const roles = Object.values(roster.participants)
  .map((p) => `${p.name.split(" ")[1]}:${p.role}`)
  .sort();
check(
  "roster syncs with roles from tickets",
  roles.join() === "Alice:owner,Bob:member",
  roles.join(", "),
);

const grant = await withTimeout(a.media, 5000, "media grant");
check(
  "realm hands out a LiveKit grant",
  grant.url === null || grant.token?.split(".").length === 3,
  grant.url ?? "LiveKit disabled",
);

const emote = withTimeout(
  new Promise<EmoteBroadcast>((resolve) => b.room.onMessage(RealmMessage.emote, resolve)),
  5000,
  "emote broadcast",
);
a.room.send(RealmMessage.emote, { emote: "wave" });
const received = await emote;
check(
  "emote broadcast reaches others",
  received.emote === "wave" && received.from === a.room.sessionId,
);

const relayed = withTimeout(
  new Promise<Uint8Array>((resolve) => b.room.onMessage(RealmMessage.pose, resolve)),
  5000,
  "pose relay",
);
a.room.sendBytes(
  RealmMessage.pose,
  encodePose({ seq: 1, t: 42, position: [1.5, 0, -0.5], yaw: 1, loco: LocoState.walk }),
);
const { from, pose } = decodeRelayedPose(await relayed);
check(
  "fallback pose relay carries the sender's id",
  from === a.room.sessionId && decodePose(pose).position[0] === 1.5,
);

const realmRejects = (ticket: string) =>
  new Client(REALM)
    .joinOrCreate(REALM_ROOM_NAME, { ticket, sessionId: session.id })
    .then((room) => {
      void room.leave();
      return null;
    })
    .catch((err: { code?: number }) => err.code ?? -1);
check(
  "realm rejects garbage tickets",
  (await realmRejects("not-a-ticket")) === RealmJoinError.badTicket,
);
check(
  "realm rejects plain session tokens",
  (await realmRejects(alice.token)) === RealmJoinError.badTicket,
);

// --- Host controls ---

a.room.send(RealmMessage.hostMute, { target: b.room.sessionId });
await waitForState(b.room, (s) => s.participants[b.room.sessionId]?.muted === true, "host mute");
check("host mute updates state and notifies the target", b.notices.at(-1)?.kind === "mutedByHost");

b.room.send(RealmMessage.hostMute, { target: a.room.sessionId });
await new Promise((r) => setTimeout(r, 300));
check(
  "members can't mute the host",
  synced(a.room).participants[a.room.sessionId]?.muted === false,
);

a.room.send(RealmMessage.setCoHost, { target: b.room.sessionId, cohost: true });
await waitForState(a.room, (s) => s.participants[b.room.sessionId]?.role === "cohost", "co-host");
check("owner can promote a co-host", true);

const link = GuestLinkResponse.parse(
  await (await call("POST", `/sessions/${session.id}/guest-links`, alice.token)).json(),
);
const guestTicket = async () =>
  JoinSessionResponse.parse(
    await (
      await call("POST", `/guest/${link.token}/join`, undefined, { displayName: "Smoke Guest" })
    ).json(),
  ).realmTicket;

b.room.send(RealmMessage.setLocked, { locked: true });
await waitForState(a.room, (s) => s.locked, "lock");
check(
  "co-host can lock; locked rooms turn guests away",
  (await realmRejects(await guestTicket())) === RealmJoinError.locked,
);
a.room.send(RealmMessage.setLocked, { locked: false });
await waitForState(a.room, (s) => !s.locked, "unlock");

const guest = await joinRealm(await guestTicket(), session.id);
await waitForState(a.room, (s) => Object.keys(s.participants).length === 3, "guest arrives");
b.room.send(RealmMessage.hostRemove, { target: guest.room.sessionId });
const guestCode = await withTimeout(guest.left, 5000, "guest removal");
check("co-host can remove a guest", guestCode === RealmCloseCode.removed);

// --- Ending ---

a.room.send(RealmMessage.endSession, {});
const bobCode = await withTimeout(b.left, 5000, "session end");
check("ending the gathering disconnects everyone", bobCode === RealmCloseCode.sessionEnded);
let status = "live";
for (let i = 0; i < 20 && status === "live"; i++) {
  await new Promise((r) => setTimeout(r, 200));
  status = SessionInfo.parse(
    await (await call("GET", `/sessions/${session.id}`, alice.token)).json(),
  ).status;
}
check("realm reports the end to the API", status === "ended");

ringing.close();
console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
