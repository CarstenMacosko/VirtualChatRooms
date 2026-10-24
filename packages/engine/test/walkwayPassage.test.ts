import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CharacterController, PHYSICS_DT } from "../src/locomotion/CharacterController";
import { PhysicsWorld } from "../src/locomotion/physics";
import { type Aabb, aabbToCollider, clipToWalkways, passableWalkways } from "../src/room/walkways";

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

function walkAcross(walkways: Parameters<typeof clipToWalkways>[1]) {
  for (const box of clipToWalkways(boxes, walkways)) physics.addBox(aabbToCollider(box));
  const c = new CharacterController(physics, { position: [-1.5, 0.05, 0], yaw: 0 });
  for (let i = 0; i < Math.round(3 / PHYSICS_DT); i++) {
    c.step(PHYSICS_DT, { move: { x: 1, z: 0 }, run: false, jump: false });
    physics.step();
  }
  return c.current.position[0];
}

describe("squeezing through a walkway", () => {
  it("is blocked by a gap narrower than the character without one", () => {
    expect(walkAcross([])).toBeLessThan(-0.5);
  });

  it("passes freely through the same gap with a walkway over it", () => {
    expect(walkAcross(passableWalkways([gap]))).toBeGreaterThan(1);
  });
});
