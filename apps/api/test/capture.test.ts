import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CHARACTER,
  CharacterController,
  collisionToWorld,
  PHYSICS_DT,
  PhysicsWorld,
  type Vec3,
} from "@vcr/engine";
import { parseRoomManifest, type ManifestTransform } from "@vcr/protocol";
import {
  analyzeRoom,
  boxesToTriangles,
  qconj,
  qmul,
  qrotate,
  type RoomAnalysis,
} from "../src/capture/analyze";
import { readCollisionGlb, writeCollisionGlb } from "../src/capture/glb";
import { processScan, rescaleRoom, roomKeys, ScanRejectedError } from "../src/capture/pipeline";
import { KiriProvider } from "../src/capture/providers";
import { readSplatPoints, SplatFileError, writePly, writeSpz } from "../src/capture/splatFile";
import { FsStorage } from "../src/storage";
import { type FileFrame, quatAxisAngle, syntheticRoomSplats, toFile } from "./syntheticRoom";

const read = (buf: Buffer, format: "ply" | "spz", opts?: Parameters<typeof readSplatPoints>[2]) =>
  readSplatPoints(Readable.from([buf]), format, opts);

/** Sample-room world point → the analyzed room's world (through the synthetic file frame). */
function analyzedWorld(p: Vec3, frame: FileFrame, a: RoomAnalysis): Vec3 {
  const f = toFile(p, frame);
  const r = qrotate(a.transform.rotation, f);
  const s = a.transform.metersPerUnit;
  const t = a.transform.translation;
  return [t[0] + s * r[0], t[1] + s * r[1], t[2] + s * r[2]];
}

const inAnyBox = (p: Vec3, a: RoomAnalysis, pad = 0) =>
  a.boxes.some((b) => b.center.every((c, i) => Math.abs(p[i]! - c) <= b.halfExtents[i]! + pad));

describe("splat files", () => {
  const splats = syntheticRoomSplats({ spacing: 0.2 });

  it("reads back what a 3DGS PLY stores", async () => {
    const points = await read(writePly(splats), "ply");
    expect(points.count).toBe(splats.length);
    expect(points.stride).toBe(1);
    for (const i of [0, 17, splats.length - 1]) {
      for (let a = 0; a < 3; a++) {
        expect(points.positions[i * 3 + a]).toBeCloseTo(splats[i]!.position[a]!, 5);
      }
      expect(points.opacity[i]).toBeCloseTo(splats[i]!.opacity, 3);
    }
  });

  it("reads SPZ positions to their fixed-point precision", async () => {
    const points = await read(writeSpz(splats), "spz");
    expect(points.count).toBe(splats.length);
    for (const i of [0, 99, splats.length - 1]) {
      for (let a = 0; a < 3; a++) {
        expect(Math.abs(points.positions[i * 3 + a]! - splats[i]!.position[a]!)).toBeLessThan(
          1 / 4096,
        );
      }
      expect(points.opacity[i]).toBeCloseTo(splats[i]!.opacity, 1);
    }
  });

  it("reads compressed (SuperSplat) PLY", async () => {
    // Two chunks of 256 splats with packed positions relative to each chunk's bounds.
    const n = 300;
    const header = [
      "ply",
      "format binary_little_endian 1.0",
      "element chunk 2",
      ...["min_x", "min_y", "min_z", "max_x", "max_y", "max_z"].map((p) => `property float ${p}`),
      `element vertex ${n}`,
      "property uint packed_position",
      "property uint packed_rotation",
      "property uint packed_scale",
      "property uint packed_color",
      "end_header\n",
    ].join("\n");
    const chunks = Buffer.alloc(2 * 24);
    [0, 0, 0, 2, 4, 8, 10, 10, 10, 11, 12, 13].forEach((v, i) => chunks.writeFloatLE(v, i * 4));
    const vertices = Buffer.alloc(n * 16);
    for (let i = 0; i < n; i++) {
      vertices.writeUInt32LE(((2047 << 21) | (0 << 11) | 1023) >>> 0, i * 16); // x max, y min, z ~mid
      vertices.writeUInt32LE(0x804020ff, i * 16 + 12); // alpha 255
    }
    const points = await read(Buffer.concat([Buffer.from(header), chunks, vertices]), "ply");
    expect(Array.from(points.positions.subarray(0, 3))).toEqual([2, 0, expect.closeTo(4, 2)]);
    expect(Array.from(points.positions.subarray(299 * 3, 300 * 3))).toEqual([
      11,
      10,
      expect.closeTo(11.5, 2),
    ]);
    expect(points.opacity[0]).toBe(1);
  });

  it("subsamples big files to a point budget", async () => {
    const points = await read(writePly(splats), "ply", { maxPoints: 100 });
    expect(points.stride).toBe(Math.ceil(splats.length / 100));
    expect(points.opacity.length).toBeLessThanOrEqual(100);
    expect(points.positions[3]).toBeCloseTo(splats[points.stride]!.position[0], 5);
    const spz = await read(writeSpz(splats), "spz", { maxPoints: 100 });
    expect(spz.positions[3]).toBeCloseTo(splats[spz.stride]!.position[0], 2);
  });

  it("rejects files that aren't splats, or are too big for phones", async () => {
    await expect(read(Buffer.from("hello world, not a ply"), "ply")).rejects.toThrow(
      SplatFileError,
    );
    await expect(
      read(
        Buffer.from("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n"),
        "ply",
      ),
    ).rejects.toThrow(/ascii/);
    await expect(read(Buffer.from("not gzip at all"), "spz")).rejects.toThrow(SplatFileError);
    await expect(read(writePly(splats), "ply", { maxSplats: 10 })).rejects.toThrow(/up to 10/);
  });
});

describe("room analysis", () => {
  const variants: Array<{
    name: string;
    frame: FileFrame;
    ceiling: boolean;
    up: string;
    scale: number;
  }> = [
    { name: "an ARKit-style export (Y up, meters)", frame: {}, ceiling: true, up: "+y", scale: 1 },
    {
      name: "a 3DGS trainer export (Y down, arbitrary scale, turned)",
      frame: {
        rotation: qmul(quatAxisAngle([0, 1, 0], 0.4), [1, 0, 0, 0]),
        scale: 0.4,
        translation: [3, -1, 2],
      },
      ceiling: true,
      up: "-y",
      scale: 1 / 0.4,
    },
    {
      name: "a Z-up export, tilted 3°, without a ceiling",
      frame: { rotation: quatAxisAngle([1, 0, 0], Math.PI / 2 + 0.05) },
      ceiling: false,
      up: "+z",
      scale: 1,
    },
    {
      name: "a scan in centimeters without a ceiling",
      frame: { scale: 100, rotation: quatAxisAngle([0, 1, 0], 1.1) },
      ceiling: false,
      up: "+y",
      scale: 0.01,
    },
  ];

  for (const v of variants) {
    it(`finds the floor, walls and scale in ${v.name}`, async () => {
      const splats = syntheticRoomSplats({ frame: v.frame, ceiling: v.ceiling, floaters: 2000 });
      const a = analyzeRoom(await read(writePly(splats), "ply"));
      expect(a.upAxis).toBe(v.up);
      // Scale: exact when the file is in meters, else from an assumed 2.5 m room height.
      expect(a.transform.metersPerUnit / v.scale).toBeGreaterThan(0.88);
      expect(a.transform.metersPerUnit / v.scale).toBeLessThan(1.12);
      const k = a.transform.metersPerUnit / v.scale; // measured meters per real meter

      // The sample room is 8 × 6 m; walls squared to the axes (either way round).
      const [long, short] = [a.size.width, a.size.depth].sort((x, y) => y - x);
      expect(long! / k).toBeCloseTo(8, 0);
      expect(short! / k).toBeCloseTo(6, 0);

      // The floor ends up at y = 0 and up is up.
      const floor = analyzedWorld([1, 0, 1.5], v.frame, a);
      expect(floor[1]).toBeCloseTo(0, 1);
      expect(analyzedWorld([1, 2, 1.5], v.frame, a)[1]).toBeCloseTo(2 * k, 1);

      // Every wall is solid at body height; open floor isn't.
      for (const wall of [
        [0, 1, -3.05],
        [0, 1, 3.05],
        [-4.05, 1, 0],
        [4.05, 1, 0],
        [2.5, 1.5, -3.05],
      ] as Vec3[]) {
        expect(inAnyBox(analyzedWorld(wall, v.frame, a), a, 0.05)).toBe(true);
      }
      expect(inAnyBox(analyzedWorld([1, 1, 1.5], v.frame, a), a)).toBe(false);
      // The sofa blocks; the coffee table too.
      expect(inAnyBox(analyzedWorld([0, 0.3, -2.1], v.frame, a), a, 0.05)).toBe(true);
      expect(inAnyBox(analyzedWorld([0.2, 0.3, -0.6], v.frame, a), a, 0.05)).toBe(true);

      // Spawns are on open floor, clear of everything.
      expect(a.spawnPoints.length).toBeGreaterThan(0);
      for (const s of a.spawnPoints) {
        expect(inAnyBox([s.position[0], 0.5, s.position[2]], a, 0.3)).toBe(false);
      }
    });
  }

  it("honors the owner's up axis and room height", async () => {
    const frame: FileFrame = { rotation: [1, 0, 0, 0] }; // upside down
    const points = await read(writePly(syntheticRoomSplats({ frame })), "ply");
    const a = analyzeRoom(points, { up: "-y", heightMeters: 3 });
    expect(a.upAxis).toBe("-y");
    expect(a.transform.scaleSource).toBe("user");
    expect(a.size.height).toBeCloseTo(3, 5);
  });

  it("rejects scans without a floor to stand on", async () => {
    // Just a lamp-sized blob of splats.
    const blob = syntheticRoomSplats({ spacing: 0.05 }).filter(
      (s) => Math.hypot(s.position[0] - 3.3, s.position[1] - 0.95, s.position[2] - 2.4) < 0.5,
    );
    const many = Array.from({ length: 5 }, () => blob).flat();
    await expect(read(writePly(many), "ply").then((p) => analyzeRoom(p))).rejects.toThrow();
  });
});

describe("collision mesh", () => {
  it("round-trips through GLB", () => {
    const { positions, indices } = boxesToTriangles(
      [{ center: [1, 2, 3], halfExtents: [0.5, 1, 1.5] }],
      (p) => p,
    );
    const back = readCollisionGlb(writeCollisionGlb(positions, indices));
    expect(Array.from(back.positions)).toEqual(Array.from(positions));
    expect(Array.from(back.indices)).toEqual(Array.from(indices));
    expect(indices.length).toBe(36);
  });

  it("keeps a walking character inside the scanned room", async () => {
    const frame: FileFrame = {
      rotation: qmul(quatAxisAngle([0, 1, 0], 0.7), [1, 0, 0, 0]),
      scale: 0.5,
    };
    const storage = new FsStorage(mkdtempSync(join(tmpdir(), "vcr-capture-")), "x".repeat(32));
    const key = roomKeys("rm_walls").source("ply");
    await storage.put(
      key,
      writePly(syntheticRoomSplats({ frame, ceiling: false })),
      "application/octet-stream",
    );
    const { manifest } = await processScan(storage, "rm_walls", "ply");

    // What the web does: GLB (file space) → world through the manifest transform → Rapier.
    const glb = readCollisionGlb(await storage.get(manifest.collision.key));
    const physics = await PhysicsWorld.create();
    physics.addTrimesh(collisionToWorld(glb.positions, manifest.transform), glb.indices);
    const spawn = manifest.spawnPoints[0]!;
    const { min, max } = manifest.bounds;
    try {
      for (const dir of [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
        { x: 0.7, z: 0.7 },
        { x: -0.7, z: 0.7 },
      ]) {
        const c = new CharacterController(physics, spawn);
        for (let i = 0; i < Math.round(6 / PHYSICS_DT); i++) {
          c.step(PHYSICS_DT, { move: dir, run: true, jump: i % 60 === 0 });
          physics.step();
        }
        const [x, y, z] = c.current.position;
        expect(x).toBeGreaterThan(min[0] + CHARACTER.radius * 0.5);
        expect(x).toBeLessThan(max[0] - CHARACTER.radius * 0.5);
        expect(z).toBeGreaterThan(min[2] + CHARACTER.radius * 0.5);
        expect(z).toBeLessThan(max[2] - CHARACTER.radius * 0.5);
        expect(y).toBeGreaterThan(-0.1); // still standing on the floor
        c.dispose();
      }
    } finally {
      physics.dispose();
    }
  });
});

describe("pipeline", () => {
  const fresh = () => new FsStorage(mkdtempSync(join(tmpdir(), "vcr-capture-")), "x".repeat(32));

  it("writes a manifest whose collision mesh lines up with the walls", async () => {
    const storage = fresh();
    await storage.put(roomKeys("rm_1").source("spz"), writeSpz(syntheticRoomSplats({})), "x");
    const progress: number[] = [];
    const result = await processScan(storage, "rm_1", "spz", {
      onProgress: (p) => progress.push(p),
    });
    expect(progress.at(-1)).toBe(1);
    const manifest = parseRoomManifest(
      JSON.parse((await storage.get(result.manifestKey)).toString()),
    );
    expect(manifest).toEqual(result.manifest);
    expect(manifest.splat).toMatchObject({ key: "rooms/rm_1/scan.spz", format: "spz" });
    expect(result.details).toMatchObject({ format: "spz", up: "+y", scaleSource: "file" });

    const glb = readCollisionGlb(await storage.get(manifest.collision.key));
    expect(manifest.collision.triangles).toBe(glb.indices.length / 3);
    const world = collisionToWorld(glb.positions, manifest.transform);
    let maxY = -Infinity;
    for (let i = 1; i < world.length; i += 3) maxY = Math.max(maxY, world[i]!);
    expect(maxY).toBeCloseTo(manifest.bounds.max[1], 1);
  });

  it("rescales by rewriting only the manifest", async () => {
    const storage = fresh();
    await storage.put(
      roomKeys("rm_2").source("ply"),
      writePly(syntheticRoomSplats({ spacing: 0.08 })),
      "x",
    );
    const first = await processScan(storage, "rm_2", "ply");
    const before = await storage.get(first.manifest.collision.key);
    const scaled = await rescaleRoom(storage, first.manifestKey, 3.2, first.details);
    expect(scaled.manifest.bounds.max[1]).toBeCloseTo(3.2, 5);
    expect(scaled.manifest.transform.scaleSource).toBe("user");
    expect(scaled.details.size.height).toBeCloseTo(3.2, 1);
    const k = 3.2 / first.manifest.bounds.max[1];
    expect(scaled.manifest.spawnPoints[0]!.position[0]).toBeCloseTo(
      first.manifest.spawnPoints[0]!.position[0] * k,
      5,
    );
    expect(await storage.get(first.manifest.collision.key)).toEqual(before);
    // A point of the collision mesh lands k times further from the origin.
    const glb = readCollisionGlb(before);
    const a = collisionToWorld(glb.positions.subarray(0, 3), first.manifest.transform);
    const b = collisionToWorld(glb.positions.subarray(0, 3), scaled.manifest.transform);
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]! * k, 4);
  });

  it("rejects a file that isn't the format its name says", async () => {
    const storage = fresh();
    await storage.put(
      roomKeys("rm_3").source("spz"),
      writePly(syntheticRoomSplats({ spacing: 0.2 })),
      "x",
    );
    await expect(processScan(storage, "rm_3", "spz")).rejects.toThrow(ScanRejectedError);
  });

  it("maps the collision mesh back into file space exactly", () => {
    const t: ManifestTransform = {
      metersPerUnit: 2.5,
      rotation: qmul(quatAxisAngle([0, 1, 0], 0.3), [1, 0, 0, 0]),
      translation: [1, 2, 3],
      up: [0, -1, 0],
      floorY: 0.8,
      scaleSource: "walls",
    };
    const inverse = qconj(t.rotation);
    const world: Vec3 = [0.4, 1.7, -2.2];
    const file = qrotate(
      inverse,
      world.map((v, i) => (v - t.translation[i]!) / t.metersPerUnit) as Vec3,
    );
    const back = collisionToWorld(new Float32Array(file), t);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(world[i]!, 5);
  });
});

describe("capture providers", () => {
  it("says video capture needs a KIRI key, and never calls out without one", async () => {
    const kiri = new KiriProvider("");
    expect(kiri.availability()).toEqual({
      available: false,
      reason: expect.stringContaining("KIRI_API_KEY"),
    });
    await expect(kiri.submit()).rejects.toThrow(/KIRI_API_KEY/);
  });
});
