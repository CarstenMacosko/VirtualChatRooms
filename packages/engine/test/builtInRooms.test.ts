import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHARACTER } from "../src/locomotion/CharacterController";
import { PhysicsWorld } from "../src/locomotion/physics";
import { inFrontOfSeat, standSpot } from "../src/locomotion/sitting";
import type { Vec3 } from "../src/math";
import { type BuiltInRoom, builtInRoomColliders } from "../src/room/builtInRoom";
import { BUILT_IN_ROOMS, builtInLayout, builtInRoom } from "../src/room/builtInRooms";
import { roomClearances } from "../src/room/playSurface";
import { spawnPointFor } from "../src/room/scannedRoom";

/** Grid cells (meters) for the walkable-floor flood fill. */
const CELL = 0.1;

/**
 * The floor someone can walk to from the first spawn point: cells where the capsule fits, joined
 * when the step between them is one the character can climb.
 */
function walkableFloor(physics: PhysicsWorld, room: BuiltInRoom) {
  const { min, max } = room.bounds;
  const nx = Math.ceil((max[0] - min[0]) / CELL);
  const nz = Math.ceil((max[2] - min[2]) / CELL);
  const floor = new Float32Array(nx * nz).fill(Number.NaN);
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const x = min[0] + (i + 0.5) * CELL;
      const z = min[2] + (k + 0.5) * CELL;
      const down = physics.castRay([x, 1.2, z], [0, -1, 0], 1.5);
      if (down === null) continue;
      const feet: Vec3 = [x, 1.2 - down, z];
      if (physics.capsuleFits(feet, CHARACTER.radius, CHARACTER.height))
        floor[i * nz + k] = feet[1];
    }
  }
  const cellOf = (p: Vec3) => [
    Math.floor((p[0] - min[0]) / CELL),
    Math.floor((p[2] - min[2]) / CELL),
  ];
  const reached = new Uint8Array(nx * nz);
  const [si, sk] = cellOf(room.spawnPoints[0]!.position);
  const queue = [si! * nz + sk!];
  reached[queue[0]!] = 1;
  while (queue.length) {
    const c = queue.pop()!;
    const i = Math.floor(c / nz);
    const k = c % nz;
    for (const [di, dk] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
      const n = ni * nz + nk;
      if (reached[n] || Number.isNaN(floor[n]!)) continue;
      if (Math.abs(floor[n]! - floor[c]!) > CHARACTER.maxStepHeight) continue;
      reached[n] = 1;
      queue.push(n);
    }
  }
  /** Whether a point is on reachable floor (or within a cell of it). */
  return (p: Vec3) => {
    const [i, k] = cellOf(p);
    for (let di = -1; di <= 1; di++) {
      for (let dk = -1; dk <= 1; dk++) {
        const n = (i! + di) * nz + (k! + dk);
        if (reached[n]) return true;
      }
    }
    return false;
  };
}

describe.each(Object.values(BUILT_IN_ROOMS).map((room) => [room.id, room] as const))(
  "built-in room %s",
  (_id, room) => {
    let physics: PhysicsWorld;
    let reachable: (p: Vec3) => boolean;
    beforeAll(async () => {
      physics = await PhysicsWorld.create();
      for (const box of builtInRoomColliders(room)) physics.addBox(box);
      reachable = walkableFloor(physics, room);
    });
    afterAll(() => physics.dispose());

    /** Height of the first solid surface straight down from above `p`. */
    const surfaceBelow = (p: Vec3) => {
      const hit = physics.castRay([p[0], p[1] + 0.3, p[2]], [0, -1, 0], 2);
      return hit === null ? null : p[1] + 0.3 - hit;
    };

    it("has unique seat ids and a layout the runtime can use", () => {
      expect(new Set(room.seats.map((s) => s.id)).size).toBe(room.seats.length);
      expect(builtInLayout(room.id).seats).toBe(room.seats);
      expect(builtInRoom(room.id)).toBe(room);
    });

    it("spawns everyone on open floor", () => {
      for (let n = 0; n < 40; n++) {
        const { position } = spawnPointFor(`user-${n}`, builtInLayout(room.id));
        expect(physics.capsuleFits(position, CHARACTER.radius, CHARACTER.height)).toBe(true);
        expect(reachable(position)).toBe(true);
      }
    });

    it("puts every seat on something solid, with room to stand up in front of it", () => {
      for (const seat of room.seats) {
        const top = surfaceBelow(seat.position);
        expect(top, `seat ${seat.id}`).not.toBeNull();
        expect(Math.abs(top! - seat.height), `seat ${seat.id}`).toBeLessThan(0.06);
        const fits = (p: Vec3) => physics.capsuleFits(p, CHARACTER.radius, CHARACTER.height);
        // Getting up ends in front of the seat, or (a chair at a desk) back where you sat
        // down from: behind it or beside it.
        const from = [
          inFrontOfSeat(seat, -0.6),
          inFrontOfSeat(seat, 0, 0.65),
          inFrontOfSeat(seat, 0, -0.65),
        ].find(fits);
        const stand = standSpot(seat, fits, from ?? seat.position);
        expect(fits(stand), `seat ${seat.id} has nowhere to stand`).toBe(true);
        expect(reachable(stand), `seat ${seat.id} can't be walked to`).toBe(true);
      }
    });

    it("lays its game tables on real tabletops you can walk up to", () => {
      expect(room.tables.length).toBeGreaterThan(0);
      for (const table of room.tables) {
        expect(table.games.length).toBeGreaterThan(0);
        const top = surfaceBelow(table.center);
        expect(Math.abs(top! - table.center[1])).toBeLessThan(0.01);
        // Some side of the table is reachable.
        const [w, d] = table.size;
        const c = Math.cos(table.yaw);
        const s = Math.sin(table.yaw);
        const sides: Vec3[] = [
          [w / 2 + 0.45, 0, 0],
          [-w / 2 - 0.45, 0, 0],
          [0, 0, d / 2 + 0.45],
          [0, 0, -d / 2 - 0.45],
        ].map(([x, , z]) => [
          table.center[0] + c * x! + s * z!,
          0,
          table.center[2] - s * x! + c * z!,
        ]);
        expect(sides.some((p) => reachable(p))).toBe(true);
      }
      expect(roomClearances(room)).toHaveLength(room.tables.length);
    });

    it("keeps everything inside its walls", () => {
      const { min, max } = room.bounds;
      for (const part of room.parts) {
        if (part.kind === "oval" || part.kind === "wallBand") continue;
        const [x, y, z] = part.center;
        expect(x).toBeGreaterThanOrEqual(min[0] - 0.5);
        expect(x).toBeLessThanOrEqual(max[0] + 0.5);
        expect(y).toBeGreaterThanOrEqual(min[1] - 0.5);
        expect(y).toBeLessThanOrEqual(max[1] + 0.5);
        expect(z).toBeGreaterThanOrEqual(min[2] - 0.5);
        expect(z).toBeLessThanOrEqual(max[2] + 0.5);
      }
    });
  },
);

describe("built-in room ids", () => {
  it("fall back to the Oval Office", () => {
    expect(builtInRoom(null).id).toBe("oval-office");
    expect(builtInRoom(undefined).id).toBe("oval-office");
  });

  it("give the presentation hall a projector screen", () => {
    expect(builtInRoom("presentation").parts.some((p) => p.kind === "screen")).toBe(true);
  });
});
