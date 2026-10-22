import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocoState } from "@vcr/protocol";
import { CameraRig } from "../src/camera/CameraRig";
import { emptyIntents } from "../src/input/intents";
import { CHARACTER, CharacterController, PHYSICS_DT } from "../src/locomotion/CharacterController";
import { PhysicsWorld } from "../src/locomotion/physics";
import { sampleRoomColliders, SAMPLE_ROOM } from "../src/room/sampleRoom";

let physics: PhysicsWorld;

beforeEach(async () => {
  physics = await PhysicsWorld.create();
  for (const box of sampleRoomColliders()) physics.addBox(box);
});
afterEach(() => physics.dispose());

function simulate(
  character: CharacterController,
  seconds: number,
  cmd: Parameters<CharacterController["step"]>[1],
) {
  const steps = Math.round(seconds / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    character.step(PHYSICS_DT, { ...cmd, jump: cmd.jump && i === 0 });
    physics.step();
  }
}

const still = { move: { x: 0, z: 0 }, run: false, jump: false };

describe("CharacterController in the sample room", () => {
  it("falls onto the floor and settles idle", () => {
    const c = new CharacterController(physics, { position: [0.3, 1, 1.2], yaw: 0 });
    simulate(c, 1.5, still);
    expect(c.current.position[1]).toBeCloseTo(0, 1);
    expect(c.current.grounded).toBe(true);
    expect(c.current.loco).toBe(LocoState.idle);
  });

  it("walks and runs at the configured speeds and faces the movement direction", () => {
    const c = new CharacterController(physics, { position: [0, 0, 1.5], yaw: 0 });
    simulate(c, 0.3, still);
    simulate(c, 1, { move: { x: 1, z: 0 }, run: false, jump: false });
    expect(c.current.speed).toBeCloseTo(CHARACTER.walkSpeed, 0);
    expect(c.current.loco).toBe(LocoState.walk);
    expect(c.current.yaw).toBeCloseTo(Math.PI / 2, 1); // facing +X
    simulate(c, 0.7, { move: { x: -1, z: 0 }, run: true, jump: false });
    expect(c.current.loco).toBe(LocoState.run);
  });

  it("stops at walls instead of passing through", () => {
    const c = new CharacterController(physics, { position: [0, 0, 1.5], yaw: 0 });
    simulate(c, 4, { move: { x: 0, z: 1 }, run: true, jump: false }); // south wall at z = 3
    expect(c.current.position[2]).toBeLessThan(3 - CHARACTER.radius + 0.05);
    expect(c.current.position[2]).toBeGreaterThan(2.5);
  });

  it("can't walk through the sofa", () => {
    const c = new CharacterController(physics, { position: [0, 0, 0.5], yaw: 0 });
    simulate(c, 3, { move: { x: 0, z: -1 }, run: false, jump: false });
    // Sofa front edge is at z = -1.7; the coffee table may stop us even earlier.
    expect(c.current.position[2]).toBeGreaterThan(-1.7);
  });

  it("climbs the 15 cm reading-nook step", () => {
    const c = new CharacterController(physics, { position: [-2.4, 0, 1.2], yaw: 0 });
    simulate(c, 0.3, still);
    simulate(c, 1.5, { move: { x: 0, z: 1 }, run: false, jump: false });
    expect(c.current.position[1]).toBeCloseTo(0.15, 1);
  });

  it("jumps and lands", () => {
    const c = new CharacterController(physics, { position: [0.3, 0, 1.2], yaw: 0 });
    simulate(c, 0.3, still);
    let peak = 0;
    let sawAir = false;
    for (let i = 0; i < 90; i++) {
      c.step(PHYSICS_DT, { ...still, jump: i === 0 });
      physics.step();
      peak = Math.max(peak, c.current.position[1]);
      if (c.current.loco === LocoState.jump || c.current.loco === LocoState.fall) sawAir = true;
    }
    expect(sawAir).toBe(true);
    expect(peak).toBeGreaterThan(0.5);
    expect(c.current.grounded).toBe(true);
  });
});

describe("CameraRig", () => {
  it("pulls the camera in when a wall is behind the player", () => {
    const rig = new CameraRig(0); // looking toward +Z, so the camera sits toward -Z
    const feet: [number, number, number] = [0, 0, -2.6]; // backed up near the north wall
    const pose = rig.compute(feet, (o, d, max) => physics.castRay(o, d, max), 1 / 60);
    expect(pose.position[2]).toBeGreaterThan(-3);
  });

  it("switches to first person at eye height", () => {
    const rig = new CameraRig(0);
    rig.applyIntents({ ...emptyIntents(), toggleCamera: true });
    expect(rig.mode).toBe("first");
    const pose = rig.compute([1, 0, 1], () => null, 1 / 60);
    expect(pose.position[1]).toBeGreaterThan(1.4);
  });

  it("keeps the sample room's spawn point inside the room", () => {
    const [spawn] = SAMPLE_ROOM.spawnPoints;
    expect(Math.abs(spawn!.position[0])).toBeLessThan(SAMPLE_ROOM.bounds.max[0]);
  });
});
