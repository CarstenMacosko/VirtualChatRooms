import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnswerCallResponse,
  CallState,
  ContactsResponse,
  DevLoginResponse,
  JoinSessionResponse,
  LinkInfo,
  LinkResponse,
  MeResponse,
  type PushPayload,
  SessionInfo,
  StartCallResponse,
} from "@vcr/protocol";
import { buildApp } from "../src/app";
import { createDatabase, type DatabaseHandle } from "../src/db/client";
import { parseEnv } from "../src/env";
import { FsStorage } from "../src/storage";

const env = parseEnv({
  NODE_ENV: "test",
  SESSION_TOKEN_SECRET: "test-secret-that-is-at-least-32-characters",
  VAPID_PUBLIC_KEY: "test-public",
  VAPID_PRIVATE_KEY: "test-private",
  ADMIN_TOKEN: "admin-secret",
});

let database: DatabaseHandle;
let app: Awaited<ReturnType<typeof buildApp>>;
const pushed: Array<{ endpoint: string; payload: PushPayload }> = [];

beforeAll(async () => {
  database = await createDatabase({});
  app = await buildApp({
    db: database.db,
    dbKind: database.kind,
    env,
    ringTimeoutMs: 300,
    storage: new FsStorage(mkdtempSync(join(tmpdir(), "vcr-links-")), env.SESSION_TOKEN_SECRET),
    pushSender: async (sub, payload) => {
      pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload });
    },
  });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function person(displayName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/dev-login",
    payload: { displayName, birthDate: "1979-09-09" },
  });
  const { token, user } = DevLoginResponse.parse(res.json());
  return withToken(token, user.id);
}

function withToken(token: string, id: string) {
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { token, id, call };
}

const anon = (method: Method, url: string, payload?: object) =>
  app.inject({ method, url, payload });

describe("device links", () => {
  it("sign the same account in on another device, once", async () => {
    const me = await person("Phone Owner");
    const link = LinkResponse.parse((await me.call("POST", "/me/device-links")).json());
    expect(link.path).toBe(`/link/${link.token}`);
    expect(LinkInfo.parse((await anon("GET", `/links/${link.token}`)).json())).toMatchObject({
      kind: "device",
      ownerName: "Phone Owner",
    });

    const claimed = DevLoginResponse.parse(
      (await anon("POST", `/links/${link.token}/claim`)).json(),
    );
    expect(claimed.user.id).toBe(me.id);
    // The new device's session works.
    const phone = withToken(claimed.token, claimed.user.id);
    expect(MeResponse.parse((await phone.call("GET", "/me")).json()).id).toBe(me.id);
    // Single use.
    expect((await anon("POST", `/links/${link.token}/claim`)).statusCode).toBe(404);
    expect((await anon("GET", `/links/${link.token}`)).statusCode).toBe(404);
  });

  it("need a signed-in account to make", async () => {
    expect((await anon("POST", "/me/device-links")).statusCode).toBe(401);
  });
});

describe("admin sign-in links", () => {
  it("make an account and a one-time sign-in link, only with the admin token", async () => {
    const make = (token: string) =>
      app.inject({
        method: "POST",
        url: "/admin/sign-in-link",
        payload: { displayName: "First Owner" },
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await make("wrong")).statusCode).toBe(403);
    const link = LinkResponse.parse((await make("admin-secret")).json());
    expect(link.kind).toBe("device");
    const claimed = DevLoginResponse.parse(
      (await anon("POST", `/links/${link.token}/claim`)).json(),
    );
    expect(claimed.user.displayName).toBe("First Owner");
    // The same name gets the same account next time.
    const again = LinkResponse.parse((await make("admin-secret")).json());
    const second = DevLoginResponse.parse(
      (await anon("POST", `/links/${again.token}/claim`)).json(),
    );
    expect(second.user.id).toBe(claimed.user.id);
  });
});

describe("invite links", () => {
  it("make an account for a friend on another device and connect you", async () => {
    const host = await person("Inviting Iris");
    const link = LinkResponse.parse((await host.call("POST", "/me/invite-links")).json());
    const info = LinkInfo.parse((await anon("GET", `/links/${link.token}`)).json());
    expect(info).toMatchObject({
      kind: "invite",
      ownerName: "Inviting Iris",
      canCreateAccount: true,
    });

    const res = await anon("POST", `/links/${link.token}/accept`, {
      displayName: "Cousin Cal",
      birthDate: "2001-02-03",
    });
    expect(res.statusCode).toBe(201);
    const cal = DevLoginResponse.parse(res.json());
    const hostContacts = ContactsResponse.parse((await host.call("GET", "/contacts")).json());
    expect(hostContacts.contacts).toEqual([
      expect.objectContaining({ userId: cal.user.id, displayName: "Cousin Cal" }),
    ]);
    // Reusable for the rest of the family.
    const res2 = await anon("POST", `/links/${link.token}/accept`, {
      displayName: "Aunt Ada",
      birthDate: "1960-02-03",
    });
    expect(res2.statusCode).toBe(201);
  });

  it("keep the 13+ gate and need a name", async () => {
    const host = await person("Gatekeeper");
    const link = LinkResponse.parse((await host.call("POST", "/me/invite-links")).json());
    const year = new Date().getUTCFullYear();
    const young = await anon("POST", `/links/${link.token}/accept`, {
      displayName: "Kid",
      birthDate: `${year - 10}-01-01`,
    });
    expect(young.statusCode).toBe(403);
    expect((await anon("POST", `/links/${link.token}/accept`, {})).statusCode).toBe(400);
  });

  it("connect people who already have accounts", async () => {
    const host = await person("Linker Lou");
    const friend = await person("Signed Sam");
    const link = LinkResponse.parse((await host.call("POST", "/me/invite-links")).json());
    expect((await friend.call("POST", `/links/${link.token}/accept`, {})).statusCode).toBe(204);
    const theirs = ContactsResponse.parse((await friend.call("GET", "/contacts")).json());
    expect(theirs.contacts.map((c) => c.userId)).toEqual([host.id]);
  });
});

describe("call links", () => {
  it("stay the same until reset", async () => {
    const owner = await person("Callable Cara");
    const a = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    const b = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    expect(b.token).toBe(a.token);
    expect(a.path).toBe(`/call/${a.token}`);
    const reset = LinkResponse.parse((await owner.call("POST", "/me/call-link/reset")).json());
    expect(reset.token).not.toBe(a.token);
    expect((await anon("GET", `/links/${a.token}`)).statusCode).toBe(404);
    expect((await anon("POST", `/links/${a.token}/call`, { displayName: "X" })).statusCode).toBe(
      404,
    );
  });

  it("ring the owner; answering lets the caller join as a guest", async () => {
    const owner = await person("Answering Ann");
    const link = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    const info = LinkInfo.parse((await anon("GET", `/links/${link.token}`)).json());
    expect(info).toMatchObject({ kind: "call", ownerName: "Answering Ann", ownerOnline: false });

    const started = StartCallResponse.parse(
      (await anon("POST", `/links/${link.token}/call`, { displayName: "Phone Phil" })).json(),
    );
    const poll = async () =>
      CallState.parse(
        (await anon("GET", `/calls/${started.callId}?secret=${started.secret}`)).json(),
      );
    expect(await poll()).toEqual({ status: "ringing", guestToken: null });
    // Without the secret, nobody else can watch or end the call.
    expect((await anon("GET", `/calls/${started.callId}?secret=nope`)).statusCode).toBe(404);
    // A stranger can't answer someone else's call.
    const stranger = await person("Not Ann");
    expect((await stranger.call("POST", `/calls/${started.callId}/answer`)).statusCode).toBe(404);

    const answered = AnswerCallResponse.parse(
      (await owner.call("POST", `/calls/${started.callId}/answer`)).json(),
    );
    const state = await poll();
    expect(state.status).toBe("accepted");
    const joined = JoinSessionResponse.parse(
      (await anon("POST", `/guest/${state.guestToken}/join`, { displayName: "Phone Phil" })).json(),
    );
    expect(joined.sessionId).toBe(answered.sessionId);
    expect(joined.role).toBe("guest");
    const session = SessionInfo.parse(
      (await owner.call("GET", `/sessions/${answered.sessionId}`)).json(),
    );
    expect(session.status).toBe("live");
    // Answering twice doesn't work; the call is over.
    expect((await owner.call("POST", `/calls/${started.callId}/answer`)).statusCode).toBe(410);
  });

  it("bring the caller into the gathering you're already in", async () => {
    const owner = await person("Busy Bea");
    const rooms = (await owner.call("GET", "/rooms")).json() as { rooms: Array<{ id: string }> };
    const live = SessionInfo.parse(
      (await owner.call("POST", "/sessions", { roomId: rooms.rooms[0]!.id })).json(),
    );
    const link = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    const started = StartCallResponse.parse(
      (await anon("POST", `/links/${link.token}/call`, { displayName: "Drop-in Dan" })).json(),
    );
    const answered = AnswerCallResponse.parse(
      (await owner.call("POST", `/calls/${started.callId}/answer`)).json(),
    );
    expect(answered.sessionId).toBe(live.id);
  });

  it("can be declined, hung up, or missed, and notify a closed app by push", async () => {
    const owner = await person("Pushy Pat");
    await owner.call("POST", "/push/subscriptions", {
      endpoint: "https://push.example/pat",
      keys: { p256dh: "p", auth: "a" },
    });
    const link = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    const call = async () =>
      StartCallResponse.parse(
        (await anon("POST", `/links/${link.token}/call`, { displayName: "Caller" })).json(),
      );
    const state = async (c: StartCallResponse) =>
      CallState.parse((await anon("GET", `/calls/${c.callId}?secret=${c.secret}`)).json()).status;

    const declined = await call();
    expect(pushed.some((p) => p.endpoint.endsWith("/pat") && p.payload.type === "call")).toBe(true);
    await owner.call("POST", `/calls/${declined.callId}/decline`);
    expect(await state(declined)).toBe("declined");

    const hungUp = await call();
    await anon("DELETE", `/calls/${hungUp.callId}?secret=${hungUp.secret}`);
    expect(await state(hungUp)).toBe("cancelled");
    expect(pushed.some((p) => p.payload.type === "call-ended")).toBe(true);

    const missed = await call();
    await sleep(500); // ringTimeoutMs is 300 in tests
    expect(await state(missed)).toBe("missed");
  });

  it("limit how often a public link can ring", async () => {
    const owner = await person("Popular Pam");
    const link = LinkResponse.parse((await owner.call("GET", "/me/call-link")).json());
    const codes = [];
    for (let i = 0; i < 8; i++) {
      codes.push(
        (await anon("POST", `/links/${link.token}/call`, { displayName: "Spam" })).statusCode,
      );
    }
    expect(codes.slice(0, 6).every((c) => c === 201)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
