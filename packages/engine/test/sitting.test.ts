import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocoState } from "@vcr/protocol";
import { ProceduralAnimator } from "../src/avatar/ProceduralAnimator";
import { CHARACTER, CharacterController, PHYSICS_DT } from "../src/locomotion/CharacterController";
import { PhysicsWorld } from "../src/locomotion/physics";
import {
  inFrontOfSeat,
  pickSeat,
  type SeatTarget,
  seatFloorPoint,
  seatedCameraBody,
  SITTING,
  standSpot,
} from "../src/locomotion/sitting";
import { SAMPLE_ROOM, sampleRoomColliders } from "../src/room/sampleRoom";

const seats = SAMPLE_ROOM.seats;
const sofaMiddle = seats.find((s) => s.id === 2)!; // (0, 0.44, -2.05), facing +Z
const armchair = seats.find((s) => s.id === 4)!; // (-2.55, 0.44, 0.4), facing +X

describe("seat picker", () => {
  it("offers the nearest free seat in front of you, within reach", () => {
    // Standing in front of the sofa's middle cushion, facing it (−Z).
    expect(pickSeat(seats, [0, 0, -1.1], Math.PI)?.id).toBe(2);
    // A step to the side: the side cushion is nearer.
    expect(pickSeat(seats, [0.55, 0, -1.1], Math.PI)?.id).toBe(3);
    // Taken seats are skipped.
    expect(pickSeat(seats, [0, 0, -1.1], Math.PI, new Set([2]))?.id).not.toBe(2);
  });

  it("ignores seats behind you, too far away, or on another floor", () => {
    expect(pickSeat(seats, [0, 0, -1.1], 0)).toBeNull(); // back to the sofa
    expect(pickSeat(seats, [0, 0, 0.6], Math.PI)).toBeNull(); // across the room
    expect(pickSeat(seats, [0, 1.5, -1.1], Math.PI)).toBeNull(); // way above it
    // Right at the seat's front edge, any heading works.
    expect(pickSeat(seats, inFrontOfSeat(sofaMiddle, 0.3), 0)?.id).toBe(2);
  });

  it("stands up in front of the seat where there's room, else where you came from", () => {
    const fallback: [number, number, number] = [9, 0, 9];
    expect(standSpot(sofaMiddle, () => true, fallback)).toEqual(
      inFrontOfSeat(sofaMiddle, SITTING.standDistances[0]),
    );
    expect(standSpot(sofaMiddle, () => false, fallback)).toEqual(fallback);
    // Facing +X, "in front" is +X.
    const spot = inFrontOfSeat(armchair, 0.55);
    expect(spot[0]).toBeCloseTo(armchair.position[0] + 0.55, 5);
    expect(spot[1]).toBeCloseTo(0, 5);
    expect(spot[2]).toBeCloseTo(armchair.position[2], 5);
  });

  it("lowers the camera while seated", () => {
    expect(seatedCameraBody(0.44, 0).eyeHeight).toBeCloseTo(1.58, 5);
    expect(seatedCameraBody(0.44, 1).eyeHeight).toBeCloseTo(1.16, 5);
    expect(seatedCameraBody(0.44, 1).distanceScale).toBeLessThan(1);
  });
});

describe("sitting in the sample room", () => {
  let physics: PhysicsWorld;
  beforeEach(async () => {
    physics = await PhysicsWorld.create();
    for (const box of sampleRoomColliders()) physics.addBox(box);
  });
  afterEach(() => physics.dispose());

  const still = { move: { x: 0, z: 0 }, run: false, jump: false };
  function simulate(c: CharacterController, seconds: number, cmd = still) {
    for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) {
      c.step(PHYSICS_DT, cmd);
      physics.step();
    }
  }
  const flat = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);

  function sitAndStand(seat: SeatTarget, from: [number, number, number], yaw: number) {
    const c = new CharacterController(physics, { position: from, yaw });
    simulate(c, 0.5);
    c.sitDown(seat);
    expect(c.current.seatId).toBe(seat.id);
    expect(c.collider.isEnabled()).toBe(false);

    // Glide over (walking), then lower onto the seat.
    simulate(c, 0.1);
    expect(c.seat?.phase).toBe("approach");
    const loco: number[] = [];
    for (let i = 0; i < 90; i++) {
      simulate(c, PHYSICS_DT);
      loco.push(c.current.loco);
    }
    expect(loco).toContain(LocoState.sitDown);
    expect(c.seat?.phase).toBe("seated");
    expect(c.current.loco).toBe(LocoState.seated);
    expect(c.current.sitAmount).toBe(1);
    expect(flat(c.current.position, seatFloorPoint(seat))).toBeLessThan(1e-6);
    expect(c.current.yaw).toBeCloseTo(seat.yaw, 5);

    // Movement doesn't push you off the seat; you have to stand up.
    simulate(c, 0.5, { move: { x: 0, z: 1 }, run: true, jump: true });
    expect(c.current.loco).toBe(LocoState.seated);
    expect(flat(c.current.position, seatFloorPoint(seat))).toBeLessThan(1e-6);

    c.standUp();
    simulate(c, 0.1);
    expect(c.current.loco).toBe(LocoState.standUp);
    simulate(c, SITTING.standTime);
    expect(c.seat).toBeNull();
    expect(c.current.loco).toBe(LocoState.idle);
    expect(c.current.seatId).toBeUndefined();
    expect(c.collider.isEnabled()).toBe(true);
    // On open floor in front of the seat, where the capsule fits.
    const end = c.current.position;
    expect(flat(end, inFrontOfSeat(seat, 0.55))).toBeLessThan(0.7);
    expect(physics.capsuleFits(end, CHARACTER.radius, CHARACTER.height, c.collider)).toBe(true);

    // And walking works again.
    simulate(c, 0.6, { move: { x: 1, z: 0 }, run: false, jump: false });
    expect(c.current.loco).toBe(LocoState.walk);
    expect(c.current.grounded).toBe(true);
    c.dispose();
  }

  it("sits on the sofa and gets up in front of it", () => {
    sitAndStand(sofaMiddle, [0.3, 0, -0.9 - 0.4], Math.PI);
  });

  it("sits in the armchair from the side and turns to face its way", () => {
    sitAndStand(armchair, [-1.6, 0, 1.1], -Math.PI / 2);
  });

  it("stops before sitting if you stand up during the approach", () => {
    const c = new CharacterController(physics, { position: [0.3, 0, -1.2], yaw: Math.PI });
    simulate(c, 0.5);
    c.sitDown(sofaMiddle);
    simulate(c, 0.05);
    c.standUp();
    expect(c.seat).toBeNull();
    expect(c.collider.isEnabled()).toBe(true);
    expect(c.current.loco).toBe(LocoState.idle);
    c.dispose();
  });

  it("teleporting (falling out of the world) leaves the seat", () => {
    const c = new CharacterController(physics, { position: [0.3, 0, -1.2], yaw: Math.PI });
    c.sitDown(sofaMiddle);
    simulate(c, 1.5);
    c.teleport([0.3, 0, 1.2], 0);
    expect(c.seat).toBeNull();
    expect(c.collider.isEnabled()).toBe(true);
    c.dispose();
  });
});

describe("seated pose", () => {
  it("lowers the hips to the seat and bends the knees, then stands back up", () => {
    const animator = new ProceduralAnimator();
    const input = { speed: 0, seatHeight: 0.44, hipsHeight: 0.92 };
    let pose = animator.update(0.1, { ...input, loco: LocoState.idle });
    for (let i = 0; i < 30; i++) pose = animator.update(0.05, { ...input, loco: LocoState.seated });
    expect(pose.hipsOffsetY).toBeCloseTo(0.44 + 0.08 - 0.92, 1);
    expect(pose.bones.leftUpperLeg[0]).toBeLessThan(-1.3); // thighs forward
    expect(pose.bones.leftLowerLeg[0]).toBeGreaterThan(1.3); // knees bent
    for (let i = 0; i < 30; i++) pose = animator.update(0.05, { ...input, loco: LocoState.idle });
    expect(Math.abs(pose.hipsOffsetY)).toBeLessThan(0.05);
    expect(Math.abs(pose.bones.leftUpperLeg[0])).toBeLessThan(0.1);
  });

  it("crosses the legs on a floor cushion", () => {
    const animator = new ProceduralAnimator();
    let pose = animator.update(0.1, { speed: 0, loco: LocoState.seated, seatHeight: 0.1 });
    for (let i = 0; i < 30; i++) {
      pose = animator.update(0.05, { speed: 0, loco: LocoState.seated, seatHeight: 0.1 });
    }
    expect(pose.bones.leftUpperLeg[2]).toBeGreaterThan(0.5);
    expect(pose.bones.rightUpperLeg[2]).toBeLessThan(-0.5);
  });
});
