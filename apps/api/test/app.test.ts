import { jwtVerify, SignJWT } from "jose";
import { recipeForSeed } from "@vcr/avatar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AvatarResponse,
  ContactsResponse,
  DevLoginResponse,
  ExchangeResponse,
  GuestLinkInfo,
  GuestLinkResponse,
  HealthResponse,
  INTERNAL_AUDIENCE,
  JoinSessionResponse,
  MeResponse,
  PublicUser,
  PushPayload,
  VapidKeyResponse,
  REALM_ISSUER,
  REALM_TICKET_AUDIENCE,
  RealmTicketClaims,
  RoomsResponse,
  SessionInfo,
  SessionsResponse,
} from "@vcr/protocol";
import { buildApp } from "../src/app";
import { createDatabase, type DatabaseHandle } from "../src/db/client";
import { parseEnv } from "../src/env";

const env = parseEnv({
  NODE_ENV: "test",
  SESSION_TOKEN_SECRET: "test-secret-that-is-at-least-32-characters",
});

let database: DatabaseHandle;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  database = await createDatabase({}); // in-memory PGlite, migrations applied
  app = await buildApp({ db: database.db, dbKind: database.kind, env, ringTimeoutMs: 300 });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const login = (displayName: string, birthDate = "1990-05-17") =>
  app.inject({ method: "POST", url: "/auth/dev-login", payload: { displayName, birthDate } });

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Signs someone in and returns helpers that call the API as them. */
async function person(displayName: string) {
  const { token, user } = DevLoginResponse.parse((await login(displayName)).json());
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const me = MeResponse.parse((await call("GET", "/me")).json());
  return { token, user, friendCode: me.friendCode, call };
}
type Person = Awaited<ReturnType<typeof person>>;

async function befriend(a: Person, b: Person) {
  await a.call("POST", "/contacts", { friendCode: b.friendCode });
  await b.call("POST", `/contacts/${a.user.id}/accept`);
}

const secretKey = new TextEncoder().encode(env.SESSION_TOKEN_SECRET);
const verifyTicket = async (ticket: string) =>
  RealmTicketClaims.parse(
    (await jwtVerify(ticket, secretKey, { audience: REALM_TICKET_AUDIENCE })).payload,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("api", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({
      ok: true,
      service: "api",
      database: "pglite",
    });
  });

  it("signs in an adult and returns the same user for the same name", async () => {
    const first = DevLoginResponse.parse((await login("Grandma Rose")).json());
    const second = DevLoginResponse.parse((await login("grandma rose")).json());
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe("grandma rose");
  });

  it("enforces the 13+ age gate without creating an account", async () => {
    const today = new Date();
    const twelve = `${today.getUTCFullYear() - 12}-01-01`;
    const res = await login("Kiddo", twelve);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("age_requirement");

    const rows = await database.db.query.users.findMany();
    expect(rows.some((u) => u.displayName === "Kiddo")).toBe(false);
  });

  it("rejects malformed sign-in requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { displayName: "", birthDate: "yesterday" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a valid session for /me", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer nope" } }))
        .statusCode,
    ).toBe(401);

    const { token, user } = DevLoginResponse.parse((await login("Uncle Bo")).json());
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(PublicUser.parse(me.json()).id).toBe(user.id);
  });

  it("gives every account a friend code", async () => {
    const a = await person("Code Holder");
    expect(a.friendCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    const again = await person("Code Holder");
    expect(again.friendCode).toBe(a.friendCode);
  });
});

describe("contacts", () => {
  it("adds by friend code, accepts, labels and removes", async () => {
    const alice = await person("Alice C");
    const bob = await person("Bob C");

    let res = await alice.call("POST", "/contacts", { friendCode: bob.friendCode.toLowerCase() });
    expect(res.statusCode).toBe(200);
    expect(ContactsResponse.parse(res.json()).outgoing.map((r) => r.userId)).toEqual([bob.user.id]);

    const bobView = ContactsResponse.parse((await bob.call("GET", "/contacts")).json());
    expect(bobView.incoming.map((r) => r.displayName)).toEqual(["Alice C"]);

    res = await bob.call("POST", `/contacts/${alice.user.id}/accept`);
    const accepted = ContactsResponse.parse(res.json());
    expect(accepted.contacts).toEqual([
      { userId: alice.user.id, displayName: "Alice C", label: null, online: false },
    ]);
    expect(accepted.incoming).toEqual([]);

    res = await alice.call("PATCH", `/contacts/${bob.user.id}`, { label: "Little brother" });
    expect(ContactsResponse.parse(res.json()).contacts[0]?.label).toBe("Little brother");

    res = await alice.call("DELETE", `/contacts/${bob.user.id}`);
    expect(ContactsResponse.parse(res.json()).contacts).toEqual([]);
    expect(ContactsResponse.parse((await bob.call("GET", "/contacts")).json()).contacts).toEqual(
      [],
    );
  });

  it("treats adding each other as accepting", async () => {
    const a = await person("Mutual A");
    const b = await person("Mutual B");
    await a.call("POST", "/contacts", { friendCode: b.friendCode });
    const res = await b.call("POST", "/contacts", { friendCode: a.friendCode });
    expect(ContactsResponse.parse(res.json()).contacts.map((c) => c.userId)).toEqual([a.user.id]);
  });

  it("rejects unknown and own friend codes", async () => {
    const a = await person("Lonely");
    expect((await a.call("POST", "/contacts", { friendCode: "ZZZZZZZZ" })).statusCode).toBe(404);
    expect((await a.call("POST", "/contacts", { friendCode: a.friendCode })).statusCode).toBe(400);
    const bad = await a.call("POST", "/contacts", { friendCode: "ABCDEFGO" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/^That isn't a friend code/);
  });

  it("keeps only accepted contacts in groups", async () => {
    const owner = await person("Group Owner");
    const friend = await person("Group Friend");
    const stranger = await person("Group Stranger");
    await befriend(owner, friend);

    let res = await owner.call("POST", "/contact-groups", {
      name: "Family",
      memberIds: [friend.user.id, stranger.user.id],
    });
    expect(res.statusCode).toBe(201);
    const [group] = ContactsResponse.parse(res.json()).groups;
    expect(group).toMatchObject({ name: "Family", memberIds: [friend.user.id] });

    res = await owner.call("PUT", `/contact-groups/${group!.id}`, { name: "Fam", memberIds: [] });
    expect(ContactsResponse.parse(res.json()).groups[0]).toMatchObject({
      name: "Fam",
      memberIds: [],
    });
    expect((await friend.call("DELETE", `/contact-groups/${group!.id}`)).statusCode).toBe(404);
    res = await owner.call("DELETE", `/contact-groups/${group!.id}`);
    expect(ContactsResponse.parse(res.json()).groups).toEqual([]);
  });
});

describe("sessions", () => {
  async function hostWithFriends(...names: string[]) {
    const host = await person(`${names[0]} Host`);
    const friends = await Promise.all(names.map((n) => person(n)));
    for (const f of friends) await befriend(host, f);
    const { rooms } = RoomsResponse.parse((await host.call("GET", "/rooms")).json());
    return { host, friends, room: rooms[0]! };
  }

  it("gives each user a sample room", async () => {
    const a = await person("Roomy");
    const first = RoomsResponse.parse((await a.call("GET", "/rooms")).json());
    expect(first.rooms).toEqual([
      { id: expect.any(String), name: "My living room", kind: "sample" },
    ]);
    const second = RoomsResponse.parse((await a.call("GET", "/rooms")).json());
    expect(second.rooms[0]?.id).toBe(first.rooms[0]?.id);
  });

  it("only lets owners host in their rooms", async () => {
    const { room } = await hostWithFriends("Owner Check");
    const other = await person("Not The Owner");
    const res = await other.call("POST", "/sessions", { roomId: room.id });
    expect(res.statusCode).toBe(404);
  });

  it("rings invitees, issues tickets with roles, and handles declines", async () => {
    const { host, friends, room } = await hostWithFriends("Gran", "Pops", "Cuz");
    const [gran, pops, cuz] = friends as [Person, Person, Person];
    const outsider = await person("Outsider");

    let res = await host.call("POST", "/sessions", {
      roomId: room.id,
      inviteUserIds: [gran.user.id, pops.user.id, outsider.user.id],
    });
    expect(res.statusCode).toBe(201);
    const session = SessionInfo.parse(res.json());
    expect(session.invites.map((i) => [i.displayName, i.status])).toEqual([
      ["Gran", "ringing"],
      ["Pops", "ringing"],
    ]);

    const listed = SessionsResponse.parse((await gran.call("GET", "/sessions")).json());
    expect(listed.sessions.map((s) => s.id)).toEqual([session.id]);
    expect(SessionsResponse.parse((await cuz.call("GET", "/sessions")).json()).sessions).toEqual(
      [],
    );

    res = await gran.call("POST", `/sessions/${session.id}/join`);
    const joined = JoinSessionResponse.parse(res.json());
    expect(joined.role).toBe("member");
    expect(await verifyTicket(joined.realmTicket)).toMatchObject({
      sub: gran.user.id,
      sessionId: session.id,
      role: "member",
      kind: "user",
    });

    const hostJoin = JoinSessionResponse.parse(
      (await host.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    expect(hostJoin.role).toBe("owner");

    expect((await pops.call("POST", `/sessions/${session.id}/decline`)).statusCode).toBe(204);
    expect((await cuz.call("POST", `/sessions/${session.id}/join`)).statusCode).toBe(404);
    expect((await outsider.call("POST", `/sessions/${session.id}/join`)).statusCode).toBe(404);

    // The host can ring more people, including someone who declined.
    res = await host.call("POST", `/sessions/${session.id}/invites`, {
      userIds: [cuz.user.id, pops.user.id],
    });
    const statuses = Object.fromEntries(
      SessionInfo.parse(res.json()).invites.map((i) => [i.displayName, i.status]),
    );
    expect(statuses).toEqual({ Gran: "accepted", Pops: "ringing", Cuz: "ringing" });
    expect(
      (await gran.call("POST", `/sessions/${session.id}/invites`, { userIds: [cuz.user.id] }))
        .statusCode,
    ).toBe(404);
  });

  it("marks unanswered rings as missed, and missed calls can still join", async () => {
    const { host, friends, room } = await hostWithFriends("Sleepy");
    const sleepy = friends[0]!;
    const { id } = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: room.id, inviteAll: true })).json(),
    );
    await sleep(450);
    const info = SessionInfo.parse((await host.call("GET", `/sessions/${id}`)).json());
    expect(info.invites[0]?.status).toBe("missed");
    expect((await sleepy.call("POST", `/sessions/${id}/join`)).statusCode).toBe(200);
  });

  it("invites whole groups", async () => {
    const { host, friends, room } = await hostWithFriends("Group A", "Group B", "Group C");
    const groups = ContactsResponse.parse(
      (
        await host.call("POST", "/contact-groups", {
          name: "Siblings",
          memberIds: [friends[0]!.user.id, friends[1]!.user.id],
        })
      ).json(),
    ).groups;
    const info = SessionInfo.parse(
      (
        await host.call("POST", "/sessions", { roomId: room.id, inviteGroupIds: [groups[0]!.id] })
      ).json(),
    );
    expect(info.invites.map((i) => i.displayName)).toEqual(["Group A", "Group B"]);
  });

  it("starting a new gathering ends the previous one", async () => {
    const { host, room } = await hostWithFriends("Serial");
    const first = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: room.id })).json(),
    );
    await host.call("POST", "/sessions", { roomId: room.id });
    const info = SessionInfo.parse((await host.call("GET", `/sessions/${first.id}`)).json());
    expect(info.status).toBe("ended");
  });

  it("admits guests by link with nothing stored about them", async () => {
    const { host, friends, room } = await hostWithFriends("Guest Friend");
    const { id } = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: room.id })).json(),
    );
    expect((await friends[0]!.call("POST", `/sessions/${id}/guest-links`)).statusCode).toBe(404);

    const link = GuestLinkResponse.parse(
      (await host.call("POST", `/sessions/${id}/guest-links`)).json(),
    );
    expect(link.path).toBe(`/join/${link.token}`);

    const info = GuestLinkInfo.parse((await app.inject({ url: `/guest/${link.token}` })).json());
    expect(info).toEqual({ hostName: "Guest Friend Host", roomName: "My living room", live: true });

    const usersBefore = (await database.db.query.users.findMany()).length;
    const res = await app.inject({
      method: "POST",
      url: `/guest/${link.token}/join`,
      payload: { displayName: "Little Sam" },
    });
    const joined = JoinSessionResponse.parse(res.json());
    expect(joined.role).toBe("guest");
    const claims = await verifyTicket(joined.realmTicket);
    expect(claims).toMatchObject({ kind: "guest", name: "Little Sam", sessionId: id });
    expect(claims.sub).toMatch(/^gst_/);
    expect((await database.db.query.users.findMany()).length).toBe(usersBefore);

    // A realm ticket is not a session token.
    const me = await app.inject({
      url: "/me",
      headers: { authorization: `Bearer ${joined.realmTicket}` },
    });
    expect(me.statusCode).toBe(401);

    expect((await app.inject({ url: "/guest/not-a-real-token" })).statusCode).toBe(404);
  });

  it("gives dev tools a guest link into the newest live gathering", async () => {
    const { host, room } = await hostWithFriends("Newest");
    const { id } = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: room.id })).json(),
    );
    const res = await app.inject({ method: "POST", url: "/dev/latest-guest-link" });
    expect(res.statusCode).toBe(201);
    const link = GuestLinkResponse.parse(res.json());
    const joined = JoinSessionResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/guest/${link.token}/join`,
          payload: { displayName: "Bot" },
        })
      ).json(),
    );
    expect(joined.sessionId).toBe(id);
  });

  it("ends sessions when the realm reports it, and only the realm may", async () => {
    const { host, friends, room } = await hostWithFriends("Ender");
    const { id } = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: room.id, inviteAll: true })).json(),
    );
    const link = GuestLinkResponse.parse(
      (await host.call("POST", `/sessions/${id}/guest-links`)).json(),
    );

    const url = `/internal/sessions/${id}/ended`;
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${host.token}` },
        })
      ).statusCode,
    ).toBe(403);

    const realmToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(REALM_ISSUER)
      .setAudience(INTERNAL_AUDIENCE)
      .setExpirationTime("1m")
      .sign(secretKey);
    const res = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${realmToken}` },
    });
    expect(res.statusCode).toBe(204);

    expect((await friends[0]!.call("POST", `/sessions/${id}/join`)).statusCode).toBe(410);
    const guest = await app.inject({
      method: "POST",
      url: `/guest/${link.token}/join`,
      payload: { displayName: "Late" },
    });
    expect(guest.statusCode).toBe(410);
    expect(
      GuestLinkInfo.parse((await app.inject({ url: `/guest/${link.token}` })).json()).live,
    ).toBe(false);
  });
});

describe("live events", () => {
  it("shuts down promptly while event streams are open", async () => {
    const own = await buildApp({ db: database.db, dbKind: database.kind, env });
    const address = await own.listen({ host: "127.0.0.1", port: 0 });
    const { token } = DevLoginResponse.parse(
      (
        await own.inject({
          method: "POST",
          url: "/auth/dev-login",
          payload: { displayName: "Still Watching", birthDate: "1990-01-01" },
        })
      ).json(),
    );
    const res = await fetch(`${address}/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.ok).toBe(true);
    // Before the fix, close() waited on this stream forever.
    await expect(
      Promise.race([own.close().then(() => "closed"), sleep(2000).then(() => "hung")]),
    ).resolves.toBe("closed");
    await res.body?.cancel().catch(() => {});
  });

  it("streams rings to the invitee and answers to the host", async () => {
    const host = await person("Caller");
    const callee = await person("Callee");
    await befriend(host, callee);
    const { rooms } = RoomsResponse.parse((await host.call("GET", "/rooms")).json());

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const open = async (token: string) => {
      const controller = new AbortController();
      const res = await fetch(`${address}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      const events: Record<string, unknown>[] = [];
      /** Resolves with the next event whose data has this `type`, skipping others. */
      const next = async (type: string): Promise<Record<string, unknown>> => {
        for (;;) {
          const event = events.shift();
          if (event?.type === type) return event;
          if (event) continue;
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop()!;
          for (const frame of frames) {
            const data = frame.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
          }
        }
      };
      return { next, close: () => controller.abort() };
    };

    const hostStream = await open(host.token);
    const calleeStream = await open(callee.token);
    // Both are online now, so each sees the other in their contacts.
    const contacts = ContactsResponse.parse((await host.call("GET", "/contacts")).json());
    expect(contacts.contacts[0]?.online).toBe(true);

    const session = SessionInfo.parse(
      (
        await host.call("POST", "/sessions", {
          roomId: rooms[0]!.id,
          inviteUserIds: [callee.user.id],
        })
      ).json(),
    );
    expect(await calleeStream.next("ring")).toMatchObject({
      sessionId: session.id,
      from: { id: host.user.id, displayName: "Caller" },
      roomName: "My living room",
    });

    await callee.call("POST", `/sessions/${session.id}/join`);
    expect(await hostStream.next("invite-response")).toMatchObject({
      sessionId: session.id,
      userId: callee.user.id,
      status: "accepted",
    });
    expect(await calleeStream.next("ring-cancelled")).toMatchObject({ sessionId: session.id });

    hostStream.close();
    calleeStream.close();
  });
});

describe("web push", () => {
  it("pushes rings to people without the app open, and withdraws them", async () => {
    const sent: { endpoint: string; payload: PushPayload }[] = [];
    let failWith: number | null = null;
    const pushApp = await buildApp({
      db: database.db,
      dbKind: database.kind,
      env: { ...env, VAPID_PUBLIC_KEY: "test-public", VAPID_PRIVATE_KEY: "test-private" },
      pushSender: async (sub, payload) => {
        if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
        sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(payload)) });
      },
    });
    const as = async (name: string) => {
      const { token, user } = DevLoginResponse.parse(
        (
          await pushApp.inject({
            method: "POST",
            url: "/auth/dev-login",
            payload: { displayName: name, birthDate: "1980-01-01" },
          })
        ).json(),
      );
      const call = (method: Method, url: string, payload?: object) =>
        pushApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
      const { friendCode } = MeResponse.parse((await call("GET", "/me")).json());
      return { user, friendCode, call };
    };
    const host = await as("Push Host");
    const callee = await as("Push Callee");
    await host.call("POST", "/contacts", { friendCode: callee.friendCode });
    await callee.call("POST", `/contacts/${host.user.id}/accept`);

    const key = VapidKeyResponse.parse((await pushApp.inject({ url: "/push/vapid-key" })).json());
    expect(key.publicKey).toBe("test-public");
    const endpoint = "https://push.example/abc";
    const subscribe = await callee.call("POST", "/push/subscriptions", {
      endpoint,
      keys: { p256dh: "p", auth: "a" },
    });
    expect(subscribe.statusCode).toBe(204);

    const { rooms } = RoomsResponse.parse((await host.call("GET", "/rooms")).json());
    const { id } = SessionInfo.parse(
      (await host.call("POST", "/sessions", { roomId: rooms[0]!.id, inviteAll: true })).json(),
    );
    await sleep(50);
    expect(sent).toEqual([
      {
        endpoint,
        payload: {
          type: "ring",
          sessionId: id,
          from: { id: host.user.id, displayName: "Push Host" },
          roomName: "My living room",
        },
      },
    ]);

    await callee.call("POST", `/sessions/${id}/decline`);
    await sleep(50);
    expect(sent.at(-1)?.payload).toEqual({ type: "ring-cancelled", sessionId: id });

    // A subscription the push service says is gone gets deleted.
    failWith = 410;
    await host.call("POST", `/sessions/${id}/invites`, { userIds: [callee.user.id] });
    await sleep(50);
    const rows = await database.db.query.pushSubscriptions.findMany();
    expect(rows.some((r) => r.endpoint === endpoint)).toBe(false);
    await pushApp.close();
  });

  it("reports push as off without VAPID keys", async () => {
    const key = VapidKeyResponse.parse((await app.inject({ url: "/push/vapid-key" })).json());
    expect(key.publicKey).toBeNull();
  });
});

describe("avatars", () => {
  it("saves a recipe, rejects junk, and puts it in realm tickets", async () => {
    const owner = await person("Avatar Owner");
    expect(AvatarResponse.parse((await owner.call("GET", "/me/avatar")).json()).recipe).toBeNull();

    const recipe = recipeForSeed("avatar-test");
    const saved = await owner.call("PUT", "/me/avatar", { recipe });
    expect(AvatarResponse.parse(saved.json()).recipe).toEqual(recipe);
    const changed = { ...recipe, glasses: "round" as const };
    await owner.call("PUT", "/me/avatar", { recipe: changed });
    expect(AvatarResponse.parse((await owner.call("GET", "/me/avatar")).json()).recipe).toEqual(
      changed,
    );

    const bad = await owner.call("PUT", "/me/avatar", { recipe: { ...recipe, skin: "red" } });
    expect(bad.statusCode).toBe(400);

    const { rooms } = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    const { id } = SessionInfo.parse(
      (await owner.call("POST", "/sessions", { roomId: rooms[0]!.id })).json(),
    );
    const joined = JoinSessionResponse.parse(
      (await owner.call("POST", `/sessions/${id}/join`)).json(),
    );
    expect((await verifyTicket(joined.realmTicket)).avatar).toEqual(changed);

    // Guests bring their own avatar; it goes into their ticket and nowhere else.
    const link = GuestLinkResponse.parse(
      (await owner.call("POST", `/sessions/${id}/guest-links`)).json(),
    );
    const guestAvatar = recipeForSeed("guest");
    const guest = JoinSessionResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/guest/${link.token}/join`,
          payload: { displayName: "Kid", avatar: guestAvatar },
        })
      ).json(),
    );
    expect((await verifyTicket(guest.realmTicket)).avatar).toEqual(guestAvatar);
  });
});

describe("real accounts (provider exchange)", () => {
  /** A stand-in for Clerk: tokens look like "valid:<provider user id>". */
  function fakeIdentity() {
    const deleted: string[] = [];
    return {
      deleted,
      provider: {
        name: "clerk",
        verify: async (token: string) => {
          if (!token.startsWith("valid:")) throw new Error("bad token");
          return { id: token.slice(6) };
        },
        profile: async () => ({ displayName: "Ada Lovelace" }),
        deleteAccount: async (id: string) => {
          deleted.push(id);
        },
      },
    };
  }

  async function withIdentity() {
    const fake = fakeIdentity();
    const authApp = await buildApp({
      db: database.db,
      dbKind: database.kind,
      env,
      identity: fake.provider,
    });
    const exchange = (payload: object) =>
      authApp.inject({ method: "POST", url: "/auth/exchange", payload });
    return { fake, authApp, exchange };
  }

  it("asks new people for a name and birthday, then signs them in", async () => {
    const { authApp, exchange } = await withIdentity();
    const first = ExchangeResponse.parse(
      (await exchange({ providerToken: "valid:clerk_1" })).json(),
    );
    expect(first).toEqual({ status: "needs-profile", suggestedName: "Ada Lovelace" });

    const done = ExchangeResponse.parse(
      (
        await exchange({
          providerToken: "valid:clerk_1",
          profile: { displayName: "Ada", birthDate: "1990-12-10" },
        })
      ).json(),
    );
    expect(done.status).toBe("signed-in");
    if (done.status !== "signed-in") return;
    const me = await authApp.inject({
      url: "/me",
      headers: { authorization: `Bearer ${done.token}` },
    });
    expect(MeResponse.parse(me.json()).displayName).toBe("Ada");

    // Next time, straight in, as the same user.
    const again = ExchangeResponse.parse(
      (await exchange({ providerToken: "valid:clerk_1" })).json(),
    );
    expect(again.status === "signed-in" && again.user.id).toBe(done.user.id);
    await authApp.close();
  });

  it("refuses under-13 sign-ups and deletes their provider account", async () => {
    const { fake, authApp, exchange } = await withIdentity();
    const twelve = `${new Date().getUTCFullYear() - 12}-01-01`;
    const res = await exchange({
      providerToken: "valid:clerk_kid",
      profile: { displayName: "Kid", birthDate: twelve },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("age_requirement");
    expect(fake.deleted).toEqual(["clerk_kid"]);
    const rows = await database.db.query.users.findMany();
    expect(rows.some((u) => u.authProviderId === "clerk_kid")).toBe(false);
    await authApp.close();
  });

  it("rejects bad provider tokens, and says when accounts aren't configured", async () => {
    const { authApp, exchange } = await withIdentity();
    expect((await exchange({ providerToken: "forged" })).statusCode).toBe(401);
    await authApp.close();
    const res = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      payload: { providerToken: "valid:x" },
    });
    expect(res.statusCode).toBe(501);
  });
});
