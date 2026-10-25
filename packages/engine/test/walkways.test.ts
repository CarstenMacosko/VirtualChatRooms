import { describe, expect, it } from "vitest";
import type { ManifestTransform, Walkway } from "@vcr/protocol";
import { collisionToWorld } from "../src/room/scannedRoom";
import {
  type Aabb,
  aabbToCollider,
  clipToWalkways,
  collisionBoxes,
  dropWalkwayTriangles,
  inWalkway,
  passableWalkways,
  WALKWAY_CUT_HEIGHT,
  WALKWAY_EDGE_THICKNESS,
  walkwayColliders,
} from "../src/room/walkways";

const walkway = (min: [number, number], max: [number, number]): Walkway => ({
  id: "w",
  min,
  max,
});

const volume = (boxes: Aabb[]) =>
  boxes.reduce(
    (sum, { min, max }) => sum + (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]),
    0,
  );

/** Whether any box contains the point. */
const blocked = (boxes: Aabb[], p: [number, number, number]) =>
  boxes.some((b) => p.every((v, a) => v > b.min[a]! && v < b.max[a]!));

describe("clipToWalkways", () => {
  // A wall 4 m wide, 0.2 m thick, standing on the floor slab's top.
  const wall: Aabb = { min: [-2, 0, -0.1], max: [2, 2.5, 0.1] };
  const floor: Aabb = { min: [-3, -0.3, -3], max: [3, 0, 3] };

  it("leaves everything alone without walkways", () => {
    expect(clipToWalkways([wall, floor], [])).toEqual([wall, floor]);
  });

  it("keeps the floor under a walkway", () => {
    expect(clipToWalkways([floor], [walkway([-1, -1], [1, 1])])).toEqual([floor]);
  });

  it("opens a doorway through a wall, keeping what's below the cut", () => {
    const out = clipToWalkways([wall], [walkway([-0.5, -1], [0.5, 1])]);
    // Below the cut, plus the wall either side of the doorway.
    expect(out).toHaveLength(3);
    expect(blocked(out, [0, 1, 0])).toBe(false);
    expect(blocked(out, [0, WALKWAY_CUT_HEIGHT / 2, 0])).toBe(true);
    expect(blocked(out, [-1, 1, 0])).toBe(true);
    expect(blocked(out, [1, 1, 0])).toBe(true);
    const removed = 1 * (2.5 - WALKWAY_CUT_HEIGHT) * 0.2;
    expect(volume(out)).toBeCloseTo(volume([wall]) - removed, 6);
  });

  it("cuts a hole out of the middle of a box in at most five pieces", () => {
    const blob: Aabb = { min: [-1, 0, -1], max: [1, 1, 1] };
    const out = clipToWalkways([blob], [walkway([-0.2, -0.3], [0.4, 0.5])]);
    expect(out).toHaveLength(5);
    expect(blocked(out, [0.1, 0.5, 0.1])).toBe(false);
    for (const p of [
      [-0.5, 0.5, 0],
      [0.7, 0.5, 0],
      [0.1, 0.5, -0.6],
      [0.1, 0.5, 0.8],
    ] as const) {
      expect(blocked(out, [...p])).toBe(true);
    }
    const removed = 0.6 * 0.8 * (1 - WALKWAY_CUT_HEIGHT);
    expect(volume(out)).toBeCloseTo(volume([blob]) - removed, 6);
  });

  it("removes clutter entirely above the cut", () => {
    const noise: Aabb = { min: [0.1, 0.3, 0.1], max: [0.3, 0.6, 0.3] };
    expect(clipToWalkways([noise], [walkway([0, 0], [1, 1])])).toEqual([]);
  });

  it("drops slivers thinner than a millimeter", () => {
    const box: Aabb = { min: [0, 0.2, 0], max: [1, 1, 1] };
    const out = clipToWalkways([box], [walkway([0.0005, -1], [2, 2])]);
    expect(out).toEqual([]);
  });

  it("applies overlapping walkways one after another", () => {
    const blob: Aabb = { min: [-1, 0, -1], max: [1, 1, 1] };
    const out = clipToWalkways(
      [blob],
      [walkway([-2, -0.2], [2, 0.2]), walkway([-0.2, -2], [0.2, 2])],
    );
    for (const p of [
      [0, 0.5, 0.9],
      [0.9, 0.5, 0],
      [0, 0.5, 0],
    ] as const) {
      expect(blocked(out, [...p])).toBe(false);
    }
    expect(blocked(out, [0.6, 0.5, 0.6])).toBe(true);
    // Four corner columns, plus the slab below the cut.
    expect(out.filter((b) => b.max[1] > WALKWAY_CUT_HEIGHT)).toHaveLength(4);
  });

  it("converts to box colliders", () => {
    expect(aabbToCollider({ min: [0, 0, 0], max: [2, 1, 4] })).toEqual({
      center: [1, 0.5, 2],
      halfExtents: [1, 0.5, 2],
    });
  });
});

describe("walkwayColliders", () => {
  // The room's edge: a wall two grid cells (16 cm) thick, beyond it nothing.
  const wall: Aabb = { min: [2, 0, -4], max: [2.16, 2.5, 4] };
  const along = walkway([0, -1], [2.05, 1]);
  const [open] = passableWalkways([along]);

  it("moves a wall the opening cut through to the walkway's edge", () => {
    const out = walkwayColliders([wall], [along]);
    const edge = out.filter((b) => b.min[0] === open!.max[0]);
    expect(edge).toEqual([
      {
        min: [open!.max[0], WALKWAY_CUT_HEIGHT, open!.min[1]],
        max: [open!.max[0] + WALKWAY_EDGE_THICKNESS, 2.5, open!.max[1]],
      },
    ]);
    // The wall either side of the walkway stays where it was.
    expect(blocked(out, [2.08, 1, -3])).toBe(true);
    expect(blocked(out, [2.08, 1, 3])).toBe(true);
    expect(blocked(out, [2.08, 1, 0])).toBe(false);
  });

  it("adds nothing where a box's own remaining piece already stands at the edge", () => {
    const thick: Aabb = { min: [2, 0, -4], max: [3, 2.5, 4] };
    expect(walkwayColliders([thick], [along])).toEqual(clipToWalkways([thick], [open!]));
  });

  it("adds nothing for clutter inside the walkway", () => {
    const noise: Aabb = { min: [0.5, 0, -0.2], max: [0.8, 0.6, 0.2] };
    expect(walkwayColliders([noise], [along])).toEqual([
      { min: [0.5, 0, -0.2], max: [0.8, WALKWAY_CUT_HEIGHT, 0.2] },
    ]);
  });

  it("keeps edge walls out of other walkways, so they surround the whole shape", () => {
    // Two overlapping walkways along the wall, then turning away from it.
    const ways = [walkway([0, -1], [2.05, 0.5]), walkway([-1, 0], [1.9, 3])];
    const out = walkwayColliders([wall], ways);
    for (const w of passableWalkways(ways)) {
      for (const b of out) {
        if (b.max[1] <= WALKWAY_CUT_HEIGHT) continue;
        const inside =
          b.max[0] > w.min[0] && b.min[0] < w.max[0] && b.max[2] > w.min[1] && b.min[2] < w.max[1];
        expect(inside).toBe(false);
      }
    }
  });
});

describe("walkways in non-box collision meshes", () => {
  const w = [walkway([0, 0], [1, 1])];

  it("knows which points are inside a walkway's prism", () => {
    expect(inWalkway(0.5, 1, 0.5, w)).toBe(true);
    expect(inWalkway(0.5, 0.01, 0.5, w)).toBe(false);
    expect(inWalkway(1.5, 1, 0.5, w)).toBe(false);
  });

  it("drops triangles that reach into a walkway", () => {
    // One triangle in the walkway above the floor, one on the floor, one outside.
    const vertices = new Float32Array([
      ...[0.4, 1, 0.4, 0.6, 1, 0.4, 0.5, 1.2, 0.6],
      ...[0.4, 0, 0.4, 0.6, 0, 0.4, 0.5, 0, 0.6],
      ...[2, 1, 2, 2.2, 1, 2, 2.1, 1.2, 2.2],
    ]);
    const indices = Uint32Array.from({ length: 9 }, (_, i) => i);
    expect([...dropWalkwayTriangles(vertices, indices, w)]).toEqual([3, 4, 5, 6, 7, 8]);
    expect(dropWalkwayTriangles(vertices, indices, [])).toBe(indices);
  });

  it("drops a big triangle that only pokes into a walkway, though its centroid is outside", () => {
    // A wall triangle spanning x 0.9 → 3: its centroid (≈ 2.2) is well outside the walkway.
    const vertices = new Float32Array([0.9, 0.2, 0.5, 3, 0.2, 0.5, 3, 2, 0.5]);
    expect([...dropWalkwayTriangles(vertices, Uint32Array.of(0, 1, 2), w)]).toEqual([]);
  });
});

/** Boxes the way post-processing writes them (analyze.ts boxesToTriangles). */
function boxMesh(boxes: Aabb[], toFile: (p: number[]) => number[] = (p) => p) {
  const positions = new Float32Array(boxes.length * 24);
  const indices = new Uint32Array(boxes.length * 36);
  const FACES = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  boxes.forEach(({ min, max }, n) => {
    for (let corner = 0; corner < 8; corner++) {
      const p = [
        corner & 4 ? max[0] : min[0],
        corner & 2 ? max[1] : min[1],
        corner & 1 ? max[2] : min[2],
      ];
      positions.set(toFile(p), (n * 8 + corner) * 3);
    }
    FACES.forEach(([a, b, c, d], f) => {
      const base = n * 8;
      indices.set(
        [base + a!, base + b!, base + c!, base + a!, base + c!, base + d!],
        n * 36 + f * 6,
      );
    });
  });
  return { positions, indices };
}

describe("collisionBoxes", () => {
  const boxes: Aabb[] = [
    { min: [-3, -0.3, -3], max: [3, 0, 3] },
    { min: [-2, 0, -0.1], max: [2, 2.5, 0.1] },
  ];

  it("reads post-processing's boxes back", () => {
    const { positions, indices } = boxMesh(boxes);
    const out = collisionBoxes(positions, indices)!;
    expect(out).toHaveLength(2);
    out.forEach((b, i) => {
      b.min.forEach((v, a) => expect(v).toBeCloseTo(boxes[i]!.min[a]!, 5));
      b.max.forEach((v, a) => expect(v).toBeCloseTo(boxes[i]!.max[a]!, 5));
    });
  });

  it("reads them back through the manifest transform (a Z-up file at 1:100 scale)", () => {
    // file (x, y, z) → world (x, z, -y) / 100, so file = (x, -z, y) · 100.
    const s = Math.SQRT1_2;
    const transform: ManifestTransform = {
      metersPerUnit: 0.01,
      rotation: [-s, 0, 0, s],
      translation: [0.5, 0, -0.25],
      up: [0, 0, 1],
      floorY: 0,
      scaleSource: "file",
    };
    const shifted = boxes.map(({ min, max }) => ({
      min: [min[0] - 0.5, min[1], min[2] + 0.25] as [number, number, number],
      max: [max[0] - 0.5, max[1], max[2] + 0.25] as [number, number, number],
    }));
    const { positions, indices } = boxMesh(shifted, ([x, y, z]) => [x! * 100, -z! * 100, y! * 100]);
    const out = collisionBoxes(collisionToWorld(positions, transform), indices)!;
    expect(out).toHaveLength(2);
    out.forEach((b, i) => {
      b.min.forEach((v, a) => expect(v).toBeCloseTo(boxes[i]!.min[a]!, 4));
      b.max.forEach((v, a) => expect(v).toBeCloseTo(boxes[i]!.max[a]!, 4));
    });
  });

  it("refuses meshes that aren't boxes", () => {
    const { positions, indices } = boxMesh(boxes);
    expect(collisionBoxes(positions, indices.subarray(0, 60))).toBeNull();
    // An index reaching into the next box.
    const crossed = indices.slice();
    crossed[3] = 9;
    expect(collisionBoxes(positions, crossed)).toBeNull();
    // A box turned 30° about Y isn't axis-aligned.
    const c = Math.cos(Math.PI / 6);
    const sn = Math.sin(Math.PI / 6);
    const turned = boxMesh(boxes, ([x, y, z]) => [c * x! + sn * z!, y!, -sn * x! + c * z!]);
    expect(collisionBoxes(turned.positions, turned.indices)).toBeNull();
    expect(collisionBoxes(new Float32Array(), new Uint32Array())).toBeNull();
  });
});
