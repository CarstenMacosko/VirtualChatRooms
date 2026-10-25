import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CharacterController, PHYSICS_DT } from "../src/locomotion/CharacterController";
import { PhysicsWorld } from "../src/locomotion/physics";
import type { Walkway } from "@vcr/protocol";
import {
  type Aabb,
  aabbToCollider,
  clipToWalkways,
  passableWalkways,
  walkwayColliders,
} from "../src/room/walkways";

// A floor and two couches 20 cm apart along x = 0: far too tight for the character.
const boxes: Aabb[] = [
  { min: [-4, -0.3, -4], max: [4, 0, 4] },
  { min: [-0.5, 0, -3], max: [0.5, 0.9, -0.1] },
  { min: [-0.5, 0, 0.1], max: [0.5, 0.9, 3] },
];
const gap = {
  id: "gap",
  min: [-0.6, -0.1] as [number, number],
  max: [0.6, 0.1] as [number, number],
};

let physics: PhysicsWorld;
beforeEach(async () => {
  physics = await PhysicsWorld.create();
});
afterEach(() => physics.dispose());

/** Walks from `from` in a straight line for `seconds`; where the character ends up. */
function walk(
  colliders: Aabb[],
  from: [number, number],
  move: { x: number; z: number },
  seconds = 3,
) {
  for (const box of colliders) physics.addBox(aabbToCollider(box));
  const c = new CharacterController(physics, { position: [from[0], 0.05, from[1]], yaw: 0 });
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) {
    c.step(PHYSICS_DT, { move, run: false, jump: false });
    physics.step();
  }
  return c.current.position;
}

function walkAcross(walkways: Parameters<typeof clipToWalkways>[1]) {
  return walk(clipToWalkways(boxes, walkways), [-1.5, 0], { x: 1, z: 0 })[0];
}

describe("squeezing through a walkway", () => {
  it("is blocked by a gap narrower than the character without one", () => {
    expect(walkAcross([])).toBeLessThan(-0.5);
  });

  it("passes freely through the same gap with a walkway over it", () => {
    expect(walkAcross(passableWalkways([gap]))).toBeGreaterThan(1);
  });
});

describe("stepping off a walkway", () => {
  const floor: Aabb = { min: [-6, -0.3, -6], max: [6, 0, 6] };
  // The room's edge at x = 2: a wall two grid cells thick, the void beyond.
  const edge: Aabb = { min: [2, 0, -5], max: [2.16, 2.5, 5] };
  // A walkway along the wall, drawn a little into it.
  const along: Walkway = { id: "along", min: [0, -1], max: [2.05, 1] };

  it("used to walk out through the wall the opening cut away", () => {
    const open = clipToWalkways([floor, edge], passableWalkways([along]));
    expect(walk(open, [1, 0], { x: 1, z: 0 })[0]).toBeGreaterThan(2.5);
  });

  it("stops at the walkway's edge, where the wall moved to", () => {
    const x = walk(walkwayColliders([floor, edge], [along]), [1, 0], { x: 1, z: 0 })[0];
    expect(x).toBeGreaterThan(along.max[0] - 0.05);
    expect(x).toBeLessThan(2.16);
  });

  it("still passes freely through a gap narrower than the character", () => {
    const end = walk(walkwayColliders(boxes, [gap]), [-1.5, 0], { x: 1, z: 0 });
    expect(end[0]).toBeGreaterThan(1);
  });

  it("still walks through a doorway a walkway opened", () => {
    // A wall across the room with a walkway through it, ending 1 m past it.
    const across: Aabb = { min: [-5, 0, 1.92], max: [5, 2.5, 2.08] };
    const door: Walkway = { id: "door", min: [-0.4, 0], max: [0.4, 3] };
    const colliders = walkwayColliders([floor, across], [door]);
    expect(walk(colliders, [0, 0.5], { x: 0, z: 1 })[2]).toBeGreaterThan(2.5);
  });

  it("walks from one overlapping walkway into the next, and off neither through the wall", () => {
    const ways: Walkway[] = [along, { id: "next", min: [1.2, 0.5], max: [2.05, 4] }];
    const colliders = walkwayColliders([floor, edge], ways);
    // Along the first walkway and up the second, hugging the wall.
    const end = walk(colliders, [1.6, -0.5], { x: 0.4, z: 1 }, 4);
    expect(end[2]).toBeGreaterThan(3);
    expect(end[0]).toBeLessThan(2.16);
  });
});
