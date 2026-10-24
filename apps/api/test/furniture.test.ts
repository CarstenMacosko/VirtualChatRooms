import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SAMPLE_ROOM, type Vec3 } from "@vcr/engine";
import type { Seat, Table } from "@vcr/protocol";
import { analyzeRoom, qmul, qrotate, type RoomAnalysis } from "../src/capture/analyze";
import { sampleSurface } from "../src/capture/meshFile";
import { readSplatPoints, writePly } from "../src/capture/splatFile";
import { type FileFrame, quatAxisAngle, syntheticRoomSplats, toFile } from "./syntheticRoom";

/** Sample-room world point → the analyzed room's world (through the synthetic file frame). */
function analyzedWorld(p: Vec3, frame: FileFrame, a: RoomAnalysis): Vec3 {
  const f = toFile(p, frame);
  const r = qrotate(a.transform.rotation, f);
  const s = a.transform.metersPerUnit;
  const t = a.transform.translation;
  return [t[0] + s * r[0], t[1] + s * r[1], t[2] + s * r[2]];
}

/** A yaw in the sample room → the analyzed room (walls get squared, so it may turn). */
function analyzedYaw(p: Vec3, yaw: number, frame: FileFrame, a: RoomAnalysis): number {
  const from = analyzedWorld(p, frame, a);
  const to = analyzedWorld([p[0] + Math.sin(yaw), p[1], p[2] + Math.cos(yaw)], frame, a);
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

const angleBetween = (a: number, b: number) =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const flat = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[2] - q[2]);

describe("furniture detection", () => {
  const variants: Array<{ name: string; frame: FileFrame }> = [
    { name: "an ARKit-style export", frame: {} },
    {
      name: "a turned 3DGS export in other units",
      frame: {
        rotation: qmul(quatAxisAngle([0, 1, 0], 0.4), [1, 0, 0, 0]),
        scale: 0.4,
        translation: [3, -1, 2],
      },
    },
  ];

  for (const v of variants) {
    it(`finds the sample room's sofa, armchair and coffee table in ${v.name}`, async () => {
      const splats = syntheticRoomSplats({ spacing: 0.03, frame: v.frame, floaters: 2000 });
      const points = await readSplatPoints(Readable.from([writePly(splats)]), "ply");
      const a = analyzeRoom(points);
      const k = a.transform.metersPerUnit * (v.frame.scale ?? 1); // ~1 when the scale is right

      // One seat per sofa cushion and one in the armchair, facing out of them; nothing else
      // (the reading nook's cushion and the bookshelf are not seats).
      expect(a.seats).toHaveLength(SAMPLE_ROOM.seats.length);
      for (const expected of SAMPLE_ROOM.seats) {
        const where = analyzedWorld(expected.position, v.frame, a);
        const seat = a.seats.find((s) => flat(s.position, where) < 0.2 * k);
        expect(seat, `seat ${expected.id}`).toBeDefined();
        expect(seat).toMatchObject({ kind: expected.kind, source: "auto" });
        expect(seat!.height / k).toBeCloseTo(0.44, 1);
        expect(
          angleBetween(seat!.yaw, analyzedYaw(expected.position, expected.yaw, v.frame, a)),
        ).toBeLessThan(0.1);
      }
      expect(new Set(a.seats.map((s) => s.id)).size).toBe(a.seats.length);

      // The coffee table, suggested without games.
      expect(a.tables).toHaveLength(1);
      const table = a.tables[0]!;
      const sample = SAMPLE_ROOM.tables[0]!;
      expect(flat(table.center, analyzedWorld(sample.center, v.frame, a))).toBeLessThan(0.1 * k);
      expect(table.center[1] / k).toBeCloseTo(0.445, 1);
      expect(Math.abs(table.size[0] / k - 1.2)).toBeLessThan(0.1);
      expect(Math.abs(table.size[1] / k - 0.6)).toBeLessThan(0.1);
      expect(table).toMatchObject({ name: "Coffee table", source: "auto", games: [] });
      // Its long side runs along the sample's X axis: local X turned by yaw about +Y.
      const along = analyzedWorld([1, 0, 0], v.frame, a);
      const origin = analyzedWorld([0, 0, 0], v.frame, a);
      const expectedYaw = Math.atan2(-(along[2] - origin[2]), along[0] - origin[0]);
      expect(angleBetween(table.yaw, expectedYaw) % Math.PI).toBeLessThan(0.1);
    });
  }

  it("finds an L-shaped sofa and a table on legs in a mesh scan, and nothing in the clutter", () => {
    const a = analyzeRoom(sampleSurface(furnishedRoomMesh(), 1_500_000));
    const near = (p: [number, number], r: number) => (s: Seat) =>
      Math.hypot(s.position[0] - p[0], s.position[2] - p[1]) < r;

    // The long arm along the west wall faces east (+X), the short arm along the north wall
    // faces south (+Z); the corner seat is left out (its front is the other arm).
    const west = a.seats.filter((s) => s.position[0] < -1.8);
    const north = a.seats.filter((s) => s.position[0] >= -1.8);
    expect(west.length).toBeGreaterThanOrEqual(2);
    expect(north.length).toBeGreaterThanOrEqual(1);
    for (const s of west) expect(angleBetween(s.yaw, Math.PI / 2)).toBeLessThan(0.1);
    for (const s of north) expect(angleBetween(s.yaw, 0)).toBeLessThan(0.1);
    for (const s of a.seats) {
      expect(s).toMatchObject({ kind: "sofa", source: "auto" });
      expect(s.height).toBeCloseTo(0.45, 1);
      // On the cushions, not the backrest or the floor.
      expect(near([-2.25, -1], 2)(s) || near([-1, -2.15], 2)(s)).toBe(true);
    }
    // Seats are a person's width apart.
    for (const s of a.seats) {
      for (const o of a.seats) {
        if (o !== s) expect(flat(s.position, o.position)).toBeGreaterThan(0.45);
      }
    }

    // The table on legs; not the ottoman (solid to the floor) or the counter (against a wall).
    expect(a.tables).toHaveLength(1);
    const table: Table = a.tables[0]!;
    expect(table.center[0]).toBeCloseTo(0.6, 1);
    expect(table.center[1]).toBeCloseTo(0.74, 1);
    expect(table.center[2]).toBeCloseTo(0.8, 1);
    expect(table.size[0]).toBeCloseTo(1.4, 1);
    expect(table.size[1]).toBeCloseTo(0.8, 1);
    expect(table.name).toBe("Table");
  });
});

/**
 * A 6 × 5 m room (2.6 m ceiling, centered on the origin) as a textured scan would mesh it: an
 * L-shaped sofa in the north-west corner, a dining table on legs, a solid ottoman and a kitchen
 * counter against the east wall. Only surfaces a scanner sees: no box bottoms.
 */
function furnishedRoomMesh() {
  const quads: Vec3[][] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => quads.push([a, b, c, d]);
  /** A box from `min` to `max` without its bottom face. */
  const box = (min: Vec3, max: Vec3) => {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  };
  const [W, D, H] = [3, 2.5, 2.6];
  // Floor in 10 cm tiles, except under solid furniture (the scanner never sees it).
  const solid: Array<[number, number, number, number]> = [
    [-2.9, -2.4, -2.1, 0.8], // sofa, west
    [-2.9, -2.4, 0.6, -1.6], // sofa, north
    [-1.2, 1.2, -0.5, 1.8], // ottoman
    [2.4, -1.5, 3, 1], // counter
  ];
  for (let x = -W; x < W - 1e-9; x += 0.1) {
    for (let z = -D; z < D - 1e-9; z += 0.1) {
      const [cx, cz] = [x + 0.05, z + 0.05];
      if (solid.some(([x0, z0, x1, z1]) => cx > x0 && cx < x1 && cz > z0 && cz < z1)) continue;
      quad([x, 0, z], [x, 0, z + 0.1], [x + 0.1, 0, z + 0.1], [x + 0.1, 0, z]);
    }
  }
  quad([-W, H, -D], [-W, H, D], [W, H, D], [W, H, -D]); // ceiling
  quad([-W, 0, -D], [-W, H, -D], [W, H, -D], [W, 0, -D]);
  quad([-W, 0, D], [W, 0, D], [W, H, D], [-W, H, D]);
  quad([-W, 0, -D], [-W, 0, D], [-W, H, D], [-W, H, -D]);
  quad([W, 0, -D], [W, H, -D], [W, H, D], [W, 0, D]);

  // L-shaped sofa: seat 0.45 m up, 0.6 m deep in front of a 0.2 m backrest 0.85 m tall, arms
  // at the open ends.
  box([-2.9, 0, -2.4], [-2.1, 0.45, 0.6]); // west arm's seat (backrest included)
  box([-2.9, 0, -2.4], [0.4, 0.45, -1.6]); // north arm's seat
  box([-2.9, 0, -2.4], [-2.7, 0.85, 0.6]); // west backrest
  box([-2.9, 0, -2.4], [0.4, 0.85, -2.2]); // north backrest
  box([-2.9, 0, 0.6], [-2.1, 0.62, 0.8]); // arm
  box([0.4, 0, -2.4], [0.6, 0.62, -1.6]); // arm

  // Dining table: a 3 cm top on four legs.
  box([-0.1, 0.72, 0.4], [1.3, 0.75, 1.2]);
  for (const [x, z] of [
    [-0.05, 0.45],
    [1.2, 0.45],
    [-0.05, 1.1],
    [1.2, 1.1],
  ]) {
    box([x!, 0, z!], [x! + 0.05, 0.72, z! + 0.05]);
  }
  // Ottoman: solid, 0.42 m up.
  box([-1.2, 0, 1.2], [-0.5, 0.42, 1.8]);
  // Kitchen counter along the east wall, 0.9 m up, with a wall cabinet above.
  box([2.4, 0, -1.5], [3, 0.9, 1]);
  box([2.65, 1.5, -1.5], [3, 2.2, 1]);

  const positions = new Float32Array(quads.flat().flat());
  const indices = new Uint32Array(
    quads.flatMap((_, q) => [0, 1, 2, 0, 2, 3].map((k) => q * 4 + k)),
  );
  return { positions, indices };
}
