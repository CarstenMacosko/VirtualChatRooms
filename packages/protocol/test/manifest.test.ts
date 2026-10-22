import { describe, expect, it } from "vitest";
import { parseRoomManifest, UnsupportedManifestError } from "../src/manifest";

const minimal = {
  manifestVersion: 1,
  roomId: "rm_123",
  splat: { key: "rooms/rm_123/room.spz", count: 1_450_000 },
  collision: { key: "rooms/rm_123/collision.glb", triangles: 38_000 },
  transform: { metersPerUnit: 1, up: [0, 1, 0], floorY: 0 },
  bounds: { min: [-4, 0, -5], max: [4, 2.7, 5] },
  spawnPoints: [{ position: [0, 0, 1.5], yaw: 3.14 }],
};

describe("room manifest", () => {
  it("fills defaults for optional sections", () => {
    const m = parseRoomManifest(minimal);
    expect(m.splat.lods).toEqual([]);
    expect(m.navmesh).toBeNull();
    expect(m.seats).toEqual([]);
    expect(m.zones).toEqual([]);
    expect(m.lighting).toEqual({ ambientColor: "#ffffff", intensity: 1 });
  });

  it("keeps fields it doesn't know about, so newer v1 manifests still load", () => {
    const m = parseRoomManifest({
      ...minimal,
      futureFeature: { enabled: true },
      splat: { ...minimal.splat, shDegree: 3 },
    });
    expect((m as Record<string, unknown>).futureFeature).toEqual({ enabled: true });
    expect((m.splat as Record<string, unknown>).shDegree).toBe(3);
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
    expect(() => parseRoomManifest({ ...minimal, manifestVersion: 2 })).toThrow(
      UnsupportedManifestError,
    );
  });
});
