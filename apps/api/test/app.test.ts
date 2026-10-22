import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevLoginResponse, HealthResponse, MediaTokenResponse, PublicUser } from "@vcr/protocol";
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
  app = await buildApp({ db: database.db, dbKind: database.kind, env });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const login = (displayName: string, birthDate = "1990-05-17") =>
  app.inject({ method: "POST", url: "/auth/dev-login", payload: { displayName, birthDate } });

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

  it("mints a LiveKit token scoped to one room", async () => {
    const { token, user } = DevLoginResponse.parse((await login("Cousin Jo")).json());
    const res = await app.inject({
      method: "POST",
      url: "/media/token",
      headers: { authorization: `Bearer ${token}` },
      payload: { room: "family-dinner" },
    });
    expect(res.statusCode).toBe(200);
    const body = MediaTokenResponse.parse(res.json());
    const { payload } = await jwtVerify(
      body.token,
      new TextEncoder().encode(env.LIVEKIT_API_SECRET),
    );
    expect(payload.sub).toBe(user.id);
    expect(payload.video).toMatchObject({ roomJoin: true, room: "family-dinner" });

    const bad = await app.inject({
      method: "POST",
      url: "/media/token",
      headers: { authorization: `Bearer ${token}` },
      payload: { room: "no spaces allowed" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
