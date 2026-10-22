import type RAPIER from "@dimforge/rapier3d-compat";
import { LocoState } from "@vcr/protocol";
import { damp, dampAngle, type Vec3, yawFromDirection } from "../math";
import type { PhysicsWorld } from "./physics";

export const CHARACTER = {
  radius: 0.28,
  height: 1.7,
  walkSpeed: 1.7,
  runSpeed: 4.2,
  jumpSpeed: 4.4,
  gravity: 14,
  /** How quickly velocity approaches the target (higher = snappier). */
  acceleration: 10,
  turnRate: 12,
  maxStepHeight: 0.3,
} as const;

/** Fixed simulation rate (PLAN.md § 3.5). */
export const PHYSICS_DT = 1 / 60;

export interface MoveCommand {
  /** World-space XZ direction, length ≤ 1. */
  move: { x: number; z: number };
  run: boolean;
  jump: boolean;
  /** First-person: face this yaw instead of turning toward the movement direction. */
  faceYaw?: number;
}

export interface CharacterState {
  /** Feet position. */
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  grounded: boolean;
  loco: LocoState;
  /** Horizontal speed, m/s. */
  speed: number;
}

/**
 * Kinematic capsule character on Rapier's character controller: walks, runs, jumps, climbs
 * small steps and slides along walls. Call `step` at PHYSICS_DT, then `physics.step()`.
 */
export class CharacterController {
  readonly collider: RAPIER.Collider;
  private readonly body: RAPIER.RigidBody;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly halfHeight = CHARACTER.height / 2;
  private readonly state: CharacterState;
  /** Intended horizontal velocity (m/s), before collisions. */
  private planar = { x: 0, z: 0 };
  private vy = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    spawn: { position: Vec3; yaw: number },
  ) {
    const R = physics.rapier;
    const center = this.centerFromFeet(spawn.position);
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z),
    );
    this.collider = physics.world.createCollider(
      R.ColliderDesc.capsule(this.halfHeight - CHARACTER.radius, CHARACTER.radius),
      this.body,
    );
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(CHARACTER.maxStepHeight, 0.15, false);
    this.controller.enableSnapToGround(0.3);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((35 * Math.PI) / 180);
    this.controller.setSlideEnabled(true);

    this.state = {
      position: [...spawn.position],
      velocity: [0, 0, 0],
      yaw: spawn.yaw,
      grounded: false,
      loco: LocoState.idle,
      speed: 0,
    };
  }

  get current(): Readonly<CharacterState> {
    return this.state;
  }

  teleport(position: Vec3, yaw: number) {
    const c = this.centerFromFeet(position);
    this.body.setTranslation(c, true);
    this.body.setNextKinematicTranslation(c);
    this.state.position = [...position];
    this.state.velocity = [0, 0, 0];
    this.planar = { x: 0, z: 0 };
    this.vy = 0;
    this.state.yaw = yaw;
  }

  step(dt: number, cmd: MoveCommand) {
    const s = this.state;
    // Intended velocity eases toward the input; the controller then decides what's possible.
    // Keeping intent separate from actual movement lets autostep work while pushing into a step.
    const targetSpeed = cmd.run ? CHARACTER.runSpeed : CHARACTER.walkSpeed;
    this.planar.x = damp(this.planar.x, cmd.move.x * targetSpeed, CHARACTER.acceleration, dt);
    this.planar.z = damp(this.planar.z, cmd.move.z * targetSpeed, CHARACTER.acceleration, dt);

    if (cmd.jump && s.grounded) {
      this.vy = CHARACTER.jumpSpeed;
      s.grounded = false;
    }
    this.vy -= CHARACTER.gravity * dt;

    const desired = { x: this.planar.x * dt, y: this.vy * dt, z: this.planar.z * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    const moved = this.controller.computedMovement();
    const grounded = this.controller.computedGrounded();

    const center = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: center.x + moved.x,
      y: center.y + moved.y,
      z: center.z + moved.z,
    });
    s.position = [s.position[0] + moved.x, s.position[1] + moved.y, s.position[2] + moved.z];
    s.velocity = [moved.x / dt, moved.y / dt, moved.z / dt];

    if (grounded && this.vy < 0) this.vy = 0;
    if (!grounded && this.vy > 0 && moved.y < desired.y - 1e-4) this.vy = 0; // bumped the ceiling
    s.grounded = grounded;
    s.speed = Math.hypot(s.velocity[0], s.velocity[2]);

    if (cmd.faceYaw !== undefined) {
      s.yaw = cmd.faceYaw;
    } else if (Math.hypot(cmd.move.x, cmd.move.z) > 0.05 && s.speed > 0.1) {
      s.yaw = dampAngle(s.yaw, yawFromDirection(cmd.move.x, cmd.move.z), CHARACTER.turnRate, dt);
    }

    s.loco = !grounded
      ? s.velocity[1] > 0
        ? LocoState.jump
        : LocoState.fall
      : s.speed > (CHARACTER.walkSpeed + CHARACTER.runSpeed) / 2
        ? LocoState.run
        : s.speed > 0.15
          ? LocoState.walk
          : LocoState.idle;
  }

  dispose() {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeRigidBody(this.body);
  }

  private centerFromFeet(p: Vec3) {
    return { x: p[0], y: p[1] + this.halfHeight, z: p[2] };
  }
}
