import { describe, expect, it } from "vitest";
import { parseRoomManifest, rotationToYUp, UnsupportedManifestError } from "../src/manifest";

const minimal = {
  manifestVersion: 3,
  roomId: "rm_123",
  splat: { key: "rooms/rm_123/room.spz", count: 1_450_000, format: "spz" },
  collision: { key: "rooms/rm_123/collision.glb", triangles: 38_000, format: "glb" },
  transform: {
    metersPerUnit: 1,
    rotation: [0, 0, 0, 1],
    translation: [0, 0, 0],
    up: [0, 1, 0],
    floorY: 0,
    scaleSource: "file",
  },
  bounds: { min: [-4, 0, -5], max: [4, 2.7, 5] },
  spawnPoints: [{ position: [0, 0, 1.5], yaw: 3.14 }],
};

describe("room manifest", () => {
  it("fills defaults for optional sections", () => {
    const m = parseRoomManifest(minimal);
    expect(m.splat?.lods).toEqual([]);
    expect(m.mesh).toBeNull();
    expect(m.navmesh).toBeNull();
    expect(m.seats).toEqual([]);
    expect(m.walkways).toEqual([]);
    expect(m.tables).toEqual([]);
    expect(m.zones).toEqual([]);
    expect(m.lighting).toEqual({ ambientColor: "#ffffff", intensity: 1 });
  });

  it("reads the room's setup: walkways, seats and game tables", () => {
    const m = parseRoomManifest({
      ...minimal,
      walkways: [{ id: "hall", min: [-1, 2], max: [0, 4] }],
      seats: [{ id: 7, position: [1, 0.45, -2], yaw: 0, height: 0.45, kind: "sofa" }],
      tables: [{ id: "coffee", center: [0, 0.4, 0], yaw: 0, size: [1, 0.5], source: "auto" }],
    });
    expect(m.seats[0]!.source).toBe("user");
    expect(m.tables[0]).toMatchObject({ name: "", games: [], source: "auto" });
    expect(() =>
      parseRoomManifest({ ...minimal, walkways: [{ id: "w", min: [1, 0], max: [1, 2] }] }),
    ).toThrow();
  });

  it("keeps fields it doesn't know about, so newer v3 manifests still load", () => {
    const m = parseRoomManifest({
      ...minimal,
      futureFeature: { enabled: true },
      splat: { ...minimal.splat, shDegree: 3 },
    });
    expect((m as Record<string, unknown>).futureFeature).toEqual({ enabled: true });
    expect((m.splat as Record<string, unknown>).shDegree).toBe(3);
  });

  it("accepts a textured mesh room instead of splats, but not both or neither", () => {
    const mesh = { key: "rooms/rm_123/scan.glb", triangles: 400_000, format: "glb" };
    const m = parseRoomManifest({ ...minimal, splat: null, mesh });
    expect(m.mesh).toEqual(mesh);
    expect(m.splat).toBeNull();
    expect(() => parseRoomManifest({ ...minimal, mesh })).toThrow(/either splats or a mesh/);
    expect(() => parseRoomManifest({ ...minimal, splat: null })).toThrow(/either splats or a mesh/);
  });

  it("accepts seats and zones", () => {
    const m = parseRoomManifest({
      ...minimal,
      seats: [{ id: 1, position: [1, 0, 1], yaw: 0, height: 0.45, kind: "sofa" }],
      zones: [
        {
          id: "z1",
          kind: "conversation",
          shape: { type: "circle", center: [0, 0, 0], radius: 2 },
        },
      ],
    });
    expect(m.seats[0]?.kind).toBe("sofa");
    expect(m.zones[0]?.shape.type).toBe("circle");
  });

  it("requires at least one spawn point", () => {
    expect(() => parseRoomManifest({ ...minimal, spawnPoints: [] })).toThrow();
  });

  it("rejects manifests from a newer major version with a clear error", () => {
    expect(() => parseRoomManifest({ ...minimal, manifestVersion: 4 })).toThrow(
      UnsupportedManifestError,
    );
  });

  it("migrates v1 manifests, deriving the file-to-world transform from up and floor", () => {
    const m = parseRoomManifest({
      manifestVersion: 1,
      roomId: "rm_1",
      splat: { key: "rooms/rm_1/room.ply", count: 10 },
      collision: { key: "rooms/rm_1/collision.glb", triangles: 12 },
      transform: { metersPerUnit: 2, up: [0, -1, 0], floorY: 0.5 },
      bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
      spawnPoints: [{ position: [0, 0, 0], yaw: 0 }],
    });
    expect(m.manifestVersion).toBe(3);
    expect(m.splat?.format).toBe("ply");
    expect(m.mesh).toBeNull();
    expect(m.collision.format).toBe("glb");
    expect(m.transform.rotation).toEqual([1, 0, 0, 0]);
    expect(m.transform.translation).toEqual([0, -1, 0]);
    expect(m.transform.scaleSource).toBe("file");
  });

  it("migrates v2 manifests: every v2 room is splats", () => {
    const m = parseRoomManifest({ ...minimal, manifestVersion: 2 });
    expect(m.manifestVersion).toBe(3);
    expect(m.splat?.key).toBe(minimal.splat.key);
    expect(m.mesh).toBeNull();
  });

  it("rotates any up direction onto +Y", () => {
    for (const up of [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
      [0, -1, 0],
      [0.1, -0.2, 0.97],
    ] as const) {
      const [x, y, z, w] = rotationToYUp(up);
      // Rotate `up` by the quaternion: v' = v + 2w(q×v) + 2q×(q×v).
      const n = Math.hypot(...up);
      const v = [up[0] / n, up[1] / n, up[2] / n];
      const c1 = [y * v[2]! - z * v[1]!, z * v[0]! - x * v[2]!, x * v[1]! - y * v[0]!];
      const c2 = [y * c1[2]! - z * c1[1]!, z * c1[0]! - x * c1[2]!, x * c1[1]! - y * c1[0]!];
      const out = v.map((c, i) => c + 2 * w * c1[i]! + 2 * c2[i]!);
      expect(out[0]).toBeCloseTo(0, 6);
      expect(out[1]).toBeCloseTo(1, 6);
      expect(out[2]).toBeCloseTo(0, 6);
    }
  });
});
