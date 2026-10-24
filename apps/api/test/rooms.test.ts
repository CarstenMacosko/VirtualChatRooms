import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateScanResponse,
  DevLoginResponse,
  JoinSessionResponse,
  MeResponse,
  type RoomInfo,
  RoomInfo as RoomInfoSchema,
  RoomSetup,
  RoomsResponse,
  SceneAssets,
  SessionInfo,
  UPLOAD_PART_BYTES,
} from "@vcr/protocol";
import { buildApp } from "../src/app";
import { readCollisionGlb } from "../src/capture/glb";
import { roomKeys } from "../src/capture/pipeline";
import { writePly } from "../src/capture/splatFile";
import { createDatabase, type DatabaseHandle } from "../src/db/client";
import { parseEnv } from "../src/env";
import { FsStorage } from "../src/storage";
import { syntheticRoomSplats } from "./syntheticRoom";

const env = parseEnv({
  NODE_ENV: "test",
  SESSION_TOKEN_SECRET: "test-secret-that-is-at-least-32-characters",
});

let database: DatabaseHandle;
let storage: FsStorage;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  database = await createDatabase({});
  storage = new FsStorage(mkdtempSync(join(tmpdir(), "vcr-rooms-")), env.SESSION_TOKEN_SECRET);
  app = await buildApp({ db: database.db, dbKind: database.kind, env, storage });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function person(displayName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/dev-login",
    payload: { displayName, birthDate: "1985-03-02" },
  });
  const { token, user } = DevLoginResponse.parse(res.json());
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const me = MeResponse.parse((await call("GET", "/me")).json());
  return { token, user, friendCode: me.friendCode, call };
}
type Person = Awaited<ReturnType<typeof person>>;

const putPart = (url: string, body: Buffer) =>
  app.inject({
    method: "PUT",
    url,
    payload: body,
    headers: { "content-type": "application/octet-stream" },
  });

/** Uploads `file` the way the web app does: create, PUT each part, complete. */
async function uploadScan(owner: Person, file: Buffer, fileName = "living-room.ply") {
  const created = await owner.call("POST", "/rooms/scans", {
    name: "Our living room",
    fileName,
    size: file.length,
  });
  expect(created.statusCode).toBe(201);
  const { room, upload } = CreateScanResponse.parse(created.json());
  const parts = [];
  for (const part of upload.parts) {
    const start = (part.partNumber - 1) * upload.partSize;
    const res = await putPart(part.url, file.subarray(start, start + upload.partSize));
    expect(res.statusCode).toBe(200);
    parts.push({ partNumber: part.partNumber, etag: String(res.headers.etag) });
  }
  const done = await owner.call("POST", `/rooms/${room.id}/upload/complete`, { parts });
  expect(done.statusCode).toBe(200);
  return { room, upload, parts };
}

async function waitForRoom(owner: Person, id: string): Promise<RoomInfo> {
  for (let i = 0; i < 400; i++) {
    const { rooms } = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    const room = rooms.find((r) => r.id === id);
    if (room && room.status !== "processing" && room.status !== "uploading") return room;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("room never finished processing");
}

async function befriend(a: Person, b: Person) {
  await a.call("POST", "/contacts", { friendCode: b.friendCode });
  await b.call("POST", `/contacts/${a.user.id}/accept`);
}

const roomFile = writePly(syntheticRoomSplats({ spacing: 0.027 }));

describe("room scans", () => {
  let owner: Person;
  let ready: RoomInfo;

  beforeAll(async () => {
    owner = await person("Scanning Sam");
    const { room } = await uploadScan(owner, roomFile);
    ready = await waitForRoom(owner, room.id);
  });

  it("uploads in parts and processes into a room", () => {
    expect(roomFile.length).toBeGreaterThan(UPLOAD_PART_BYTES); // really multipart
    expect(ready.status).toBe("ready");
    expect(ready.kind).toBe("scan");
    expect(ready.scan).toMatchObject({ format: "ply", up: "+y", scaleSource: "file" });
    expect(ready.scan!.size.width).toBeCloseTo(8, 0);
    expect(ready.scan!.size.depth).toBeCloseTo(6, 0);
  });

  it("lists the sample room first and says video capture needs a KIRI key", async () => {
    const res = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    expect(res.rooms[0]?.kind).toBe("sample");
    expect(res.rooms.map((r) => r.id)).toContain(ready.id);
    expect(res.capture.video).toEqual({
      available: false,
      reason: expect.stringContaining("KIRI_API_KEY"),
    });
    const video = await owner.call("POST", "/rooms/videos", {});
    expect(video.statusCode).toBe(503);
    expect(video.json().message).toContain("KIRI_API_KEY");
  });

  it("validates the file's name and size up front", async () => {
    const bad = async (body: object) => (await owner.call("POST", "/rooms/scans", body)).statusCode;
    expect(await bad({ name: "x", fileName: "room.obj", size: 10_000 })).toBe(400);
    expect(await bad({ name: "x", fileName: "room.ply", size: 10 })).toBe(400);
    expect(await bad({ name: "x", fileName: "room.spz", size: 2 * 1024 ** 3 })).toBe(400);
    expect(await bad({ name: "", fileName: "room.ply", size: 10_000 })).toBe(400);
  });

  it("fails a file that isn't really a splat, with a reason", async () => {
    const junk = Buffer.alloc(50_000, 7);
    const { room } = await uploadScan(owner, junk, "not-really.ply");
    const failed = await waitForRoom(owner, room.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/isn't a PLY/);
    expect((await owner.call("DELETE", `/rooms/${room.id}`)).statusCode).toBe(204);
  });

  it("only lets the owner upload, adjust or delete", async () => {
    const stranger = await person("Nosy Neighbor");
    const created = CreateScanResponse.parse(
      (
        await owner.call("POST", "/rooms/scans", {
          name: "Pending",
          fileName: "pending.spz",
          size: 5000,
        })
      ).json(),
    );
    const id = created.room.id;
    expect(
      (
        await stranger.call("POST", `/rooms/${id}/upload/complete`, {
          parts: [{ partNumber: 1, etag: "x" }],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await stranger.call("PATCH", `/rooms/${ready.id}`, { name: "Mine now" })).statusCode,
    ).toBe(404);
    expect((await stranger.call("DELETE", `/rooms/${ready.id}`)).statusCode).toBe(404);
    expect((await stranger.call("POST", "/sessions", { roomId: ready.id })).statusCode).toBe(404);
    // Nor can anyone host in a room that's still uploading.
    expect((await owner.call("POST", "/sessions", { roomId: id })).statusCode).toBe(409);
    // Rooms list is per person.
    const theirs = RoomsResponse.parse((await stranger.call("GET", "/rooms")).json());
    expect(theirs.rooms.map((r) => r.id)).not.toContain(ready.id);
    await owner.call("DELETE", `/rooms/${id}`);
  });

  it("rejects tampered or expired upload links", async () => {
    const { upload, room } = CreateScanResponse.parse(
      (
        await owner.call("POST", "/rooms/scans", { name: "T", fileName: "t.ply", size: 5000 })
      ).json(),
    );
    const url = upload.parts[0]!.url;
    expect((await putPart(url.replace(/sig=[^&]+/, "sig=AAAA"), Buffer.alloc(10))).statusCode).toBe(
      403,
    );
    expect((await putPart(url.replace(/\/1\?/, "/2?"), Buffer.alloc(10))).statusCode).toBe(403);
    expect((await putPart(url.replace(/exp=\d+/, "exp=1000"), Buffer.alloc(10))).statusCode).toBe(
      403,
    );
    // An incomplete upload can't be completed.
    const done = await owner.call("POST", `/rooms/${room.id}/upload/complete`, {
      parts: [{ partNumber: 1, etag: '"nope"' }],
    });
    expect(done.statusCode).toBe(400);
    await owner.call("DELETE", `/rooms/${room.id}`);
  });

  it("gives everyone in a live gathering signed, session-scoped asset URLs", async () => {
    const guestHost = await person("Gathering Gina");
    await befriend(owner, guestHost);
    const session = SessionInfo.parse(
      (
        await owner.call("POST", "/sessions", {
          roomId: ready.id,
          inviteUserIds: [guestHost.user.id],
        })
      ).json(),
    );
    expect(session.room).toMatchObject({ id: ready.id, kind: "scan" });

    const joined = JoinSessionResponse.parse(
      (await owner.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    const scene = joined.scene!;
    expect(scene.manifest.roomId).toBe(ready.id);
    expect(scene.manifest.splat!.format).toBe("ply");
    const splatUrl = scene.urls[scene.manifest.splat!.key]!;
    const collisionUrl = scene.urls[scene.manifest.collision.key]!;
    expect(splatUrl).toMatch(/^\/storage\/o\/rooms\/.+\/scan\.ply\?/);

    // The invitee gets URLs too, and they fetch the real files (no sign-in needed: the URL is it).
    const invited = JoinSessionResponse.parse(
      (await guestHost.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    expect(Object.keys(invited.scene!.urls)).toEqual(Object.keys(scene.urls));
    const splat = await app.inject({ url: splatUrl });
    expect(splat.statusCode).toBe(200);
    expect(splat.rawPayload.equals(roomFile)).toBe(true);
    const ranged = await app.inject({ url: splatUrl, headers: { range: "bytes=0-2" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe("ply");
    const glb = readCollisionGlb((await app.inject({ url: collisionUrl })).rawPayload);
    expect(glb.indices.length / 3).toBe(scene.manifest.collision.triangles);

    // Guests through a link get them as well.
    const link = (await owner.call("POST", `/sessions/${session.id}/guest-links`)).json();
    const guest = JoinSessionResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/guest/${link.token}/join`,
          payload: { displayName: "Kid" },
        })
      ).json(),
    );
    expect(guest.scene?.manifest.roomId).toBe(ready.id);

    // Tampering with a URL breaks it; ending the gathering revokes all of them.
    expect((await app.inject({ url: splatUrl.replace(/sig=[^&]+/, "sig=AAAA") })).statusCode).toBe(
      403,
    );
    expect(
      (await app.inject({ url: splatUrl.replace("scan.ply", "manifest.json") })).statusCode,
    ).toBe(403);
    await owner.call("POST", `/sessions/${session.id}/end`);
    expect((await app.inject({ url: splatUrl })).statusCode).toBe(403);
  });

  it("the sample room has no scene: every client builds it", async () => {
    const { rooms } = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    const sample = rooms.find((r) => r.kind === "sample")!;
    const session = SessionInfo.parse(
      (await owner.call("POST", "/sessions", { roomId: sample.id })).json(),
    );
    const joined = JoinSessionResponse.parse(
      (await owner.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    expect(joined.scene).toBeNull();
    await owner.call("POST", `/sessions/${session.id}/end`);
  });

  it("moves a live gathering to another room, host only", async () => {
    const { rooms } = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    const sample = rooms.find((r) => r.kind === "sample")!;
    const session = SessionInfo.parse(
      (await owner.call("POST", "/sessions", { roomId: sample.id })).json(),
    );
    const before = JoinSessionResponse.parse(
      (await owner.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    expect(before.scene).toBeNull();

    const stranger = await person("Room Thief");
    expect(
      (await stranger.call("POST", `/sessions/${session.id}/room`, { roomId: ready.id }))
        .statusCode,
    ).toBe(404);
    const moved = await owner.call("POST", `/sessions/${session.id}/room`, { roomId: ready.id });
    expect(moved.statusCode).toBe(200);
    expect(SessionInfo.parse(moved.json()).room.id).toBe(ready.id);
    const after = JoinSessionResponse.parse(
      (await owner.call("POST", `/sessions/${session.id}/join`)).json(),
    );
    expect(after.room.id).toBe(ready.id);
    expect(after.scene?.manifest.roomId).toBe(ready.id);
    await owner.call("POST", `/sessions/${session.id}/end`);
  });

  it("lets the owner set up walkways, seats and game tables", async () => {
    const before = SceneAssets.parse((await owner.call("GET", `/rooms/${ready.id}/scene`)).json());
    // Post-processing suggests the sample room's sofa, armchair and coffee table.
    expect(before.manifest.walkways).toEqual([]);
    expect(before.manifest.seats.length).toBeGreaterThan(0);
    expect(before.manifest.tables).toHaveLength(1);
    for (const x of [...before.manifest.seats, ...before.manifest.tables]) {
      expect(x.source).toBe("auto");
    }
    // Signed without a session: the owner isn't in a gathering while setting up.
    const meshUrl = before.urls[before.manifest.collision.key]!;
    expect((await app.inject({ method: "GET", url: meshUrl })).statusCode).toBe(200);

    const setup = {
      walkways: [{ id: "door", min: [-0.5, 1], max: [0.5, 2.5] }],
      seats: [{ id: 1, position: [1, 0.45, -2], yaw: 0, height: 0.45, kind: "sofa" }],
      tables: [{ id: "t1", center: [0, 0.42, 0], yaw: 0.3, size: [0.9, 0.6], games: ["jigsaw"] }],
    };
    const saved = await owner.call("PUT", `/rooms/${ready.id}/setup`, setup);
    expect(saved.statusCode).toBe(200);
    expect(RoomSetup.parse(saved.json()).seats[0]!.source).toBe("user");
    const after = SceneAssets.parse((await owner.call("GET", `/rooms/${ready.id}/scene`)).json());
    expect(after.manifest.walkways).toEqual(setup.walkways);
    expect(after.manifest.tables[0]).toMatchObject({ id: "t1", games: ["jigsaw"], name: "" });

    // Outside the room, duplicate ids, backwards rectangles, other people: all refused.
    const far = { ...setup, tables: [{ ...setup.tables[0], center: [40, 0.4, 0] }] };
    expect((await owner.call("PUT", `/rooms/${ready.id}/setup`, far)).statusCode).toBe(400);
    const twice = { ...setup, seats: [setup.seats[0], setup.seats[0]] };
    expect((await owner.call("PUT", `/rooms/${ready.id}/setup`, twice)).statusCode).toBe(400);
    const backwards = { ...setup, walkways: [{ id: "w", min: [1, 1], max: [0, 2] }] };
    expect((await owner.call("PUT", `/rooms/${ready.id}/setup`, backwards)).statusCode).toBe(400);
    const stranger = await person("Setup Stranger");
    expect((await stranger.call("PUT", `/rooms/${ready.id}/setup`, setup)).statusCode).toBe(404);
    expect((await stranger.call("GET", `/rooms/${ready.id}/scene`)).statusCode).toBe(404);
  });

  it("lets the owner fix the scale and rename", async () => {
    const scene = async () =>
      SceneAssets.parse((await owner.call("GET", `/rooms/${ready.id}/scene`)).json()).manifest;
    const before = await scene();
    const res = await owner.call("PATCH", `/rooms/${ready.id}`, { heightMeters: 3, name: "Den" });
    expect(res.statusCode).toBe(200);
    const room = RoomInfoSchema.parse(res.json());
    expect(room.name).toBe("Den");
    expect(room.scan!.size.height).toBeCloseTo(3, 1);
    expect(room.scan!.scaleSource).toBe("user");
    // The setup scales with the room.
    const k = 3 / before.bounds.max[1];
    const after = await scene();
    expect(after.tables[0]!.size[0]).toBeCloseTo(before.tables[0]!.size[0] * k, 5);
    expect(after.walkways[0]!.max[1]).toBeCloseTo(before.walkways[0]!.max[1] * k, 5);
    expect(after.seats[0]!.height).toBeCloseTo(before.seats[0]!.height * k, 5);
    expect((await owner.call("PATCH", `/rooms/${ready.id}`, {})).statusCode).toBe(400);
  });

  it("re-processes with the owner's up axis", async () => {
    const res = await owner.call("PATCH", `/rooms/${ready.id}`, { up: "+y" });
    expect(RoomInfoSchema.parse(res.json()).status).toBe("processing");
    const again = await waitForRoom(owner, ready.id);
    expect(again.status).toBe("ready");
    expect(again.scan?.up).toBe("+y");
  });

  it("deletes a room with its files, ending a gathering in it", async () => {
    const session = SessionInfo.parse(
      (await owner.call("POST", "/sessions", { roomId: ready.id })).json(),
    );
    expect(await storage.size(roomKeys(ready.id).source("ply"))).toBe(roomFile.length);
    expect((await owner.call("DELETE", `/rooms/${ready.id}`)).statusCode).toBe(204);
    expect(await storage.size(roomKeys(ready.id).source("ply"))).toBeNull();
    expect(await storage.size(roomKeys(ready.id).manifest)).toBeNull();
    expect((await owner.call("GET", `/sessions/${session.id}`)).statusCode).toBe(404);
    const { rooms } = RoomsResponse.parse((await owner.call("GET", "/rooms")).json());
    expect(rooms.map((r) => r.id)).not.toContain(ready.id);
    // The sample room stays.
    const sample = rooms.find((r) => r.kind === "sample")!;
    expect((await owner.call("DELETE", `/rooms/${sample.id}`)).statusCode).toBe(400);
  });
});
