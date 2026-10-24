import type RAPIER from "@dimforge/rapier3d-compat";
import { LocoState } from "@vcr/protocol";
import { clamp, damp, dampAngle, lerp, lerpAngle, type Vec3, yawFromDirection } from "../math";
import type { PhysicsWorld } from "./physics";
import { inFrontOfSeat, type SeatTarget, seatFloorPoint, SITTING, standSpot } from "./sitting";

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
  /** The seat you're sitting on, getting onto or getting up from. */
  seatId?: number;
  /** 0 standing … 1 seated: how far the hips are lowered onto the seat. */
  sitAmount: number;
}

/**
 * Sitting is a short scripted move with physics off (the capsule would fight the couch's
 * collision): glide to the front of the seat while turning to face its way, lower onto it, stay,
 * then get up onto open floor in front of it (ADR 0020).
 */
export type SeatPhase = "approach" | "lower" | "seated" | "rise";
interface Seating {
  seat: SeatTarget;
  phase: SeatPhase;
  t: number;
  duration: number;
  from: Vec3;
  to: Vec3;
  fromYaw: number;
  /** Where you sat down from: the stand-up spot of last resort. */
  cameFrom: Vec3;
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
  private seating: Seating | null = null;

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
      sitAmount: 0,
    };
  }

  get current(): Readonly<CharacterState> {
    return this.state;
  }

  /** The seat you're on (or on your way onto or off), and where in that you are. */
  get seat(): { seat: SeatTarget; phase: SeatPhase } | null {
    return this.seating && { seat: this.seating.seat, phase: this.seating.phase };
  }

  teleport(position: Vec3, yaw: number) {
    if (this.seating) this.leaveSeat();
    const c = this.centerFromFeet(position);
    this.body.setTranslation(c, true);
    this.body.setNextKinematicTranslation(c);
    this.state.position = [...position];
    this.state.velocity = [0, 0, 0];
    this.planar = { x: 0, z: 0 };
    this.vy = 0;
    this.state.yaw = yaw;
  }

  /** Starts sitting down on `seat` (claim it first). Ignored if you're already on a seat. */
  sitDown(seat: SeatTarget) {
    if (this.seating) return;
    const s = this.state;
    const to = inFrontOfSeat(seat, SITTING.approach);
    const distance = Math.hypot(to[0] - s.position[0], to[2] - s.position[2]);
    this.collider.setEnabled(false);
    this.planar = { x: 0, z: 0 };
    this.vy = 0;
    this.seating = {
      seat,
      phase: "approach",
      t: 0,
      duration: clamp(distance / SITTING.glideSpeed, 0.15, SITTING.maxGlide),
      from: [...s.position],
      to,
      fromYaw: s.yaw,
      cameFrom: [...s.position],
    };
    s.seatId = seat.id;
  }

  /**
   * Gets up from the seat onto the first open spot in front of it (`fits` says whether a spot is
   * clear; by default the capsule must fit there). Before you've sat down it just stops.
   */
  standUp(fits?: (feet: Vec3) => boolean) {
    const seating = this.seating;
    if (!seating || seating.phase === "rise") return;
    if (seating.phase === "approach") {
      this.leaveSeat();
      return;
    }
    const check =
      fits ??
      ((feet: Vec3) =>
        this.physics.capsuleFits(feet, CHARACTER.radius, CHARACTER.height, this.collider));
    this.seating = {
      ...seating,
      phase: "rise",
      t: 0,
      duration: SITTING.standTime,
      from: [...this.state.position],
      to: standSpot(seating.seat, check, seating.cameFrom),
      fromYaw: this.state.yaw,
    };
  }

  step(dt: number, cmd: MoveCommand) {
    if (this.seating) {
      this.seatStep(dt);
      return;
    }
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

  private seatStep(dt: number) {
    const seating = this.seating!;
    const s = this.state;
    seating.t += dt;
    const k = seating.phase === "seated" ? 1 : clamp(seating.t / seating.duration, 0, 1);
    const eased = k * k * (3 - 2 * k);
    const at: Vec3 = [
      lerp(seating.from[0], seating.to[0], eased),
      lerp(seating.from[1], seating.to[1], eased),
      lerp(seating.from[2], seating.to[2], eased),
    ];
    s.velocity = [
      (at[0] - s.position[0]) / dt,
      (at[1] - s.position[1]) / dt,
      (at[2] - s.position[2]) / dt,
    ];
    s.speed = Math.hypot(s.velocity[0], s.velocity[2]);
    s.position = at;
    s.grounded = true;
    const seatYaw = seating.seat.yaw;
    switch (seating.phase) {
      case "approach":
        s.yaw = lerpAngle(seating.fromYaw, seatYaw, eased);
        s.loco = s.speed > 0.15 ? LocoState.walk : LocoState.idle;
        s.sitAmount = 0;
        break;
      case "lower":
        s.yaw = seatYaw;
        s.loco = LocoState.sitDown;
        s.sitAmount = eased;
        break;
      case "seated":
        s.yaw = seatYaw;
        s.loco = LocoState.seated;
        s.sitAmount = 1;
        break;
      case "rise":
        s.loco = LocoState.standUp;
        s.sitAmount = 1 - eased;
        break;
    }
    this.body.setNextKinematicTranslation(this.centerFromFeet(at));
    if (k < 1) return;
    if (seating.phase === "approach") {
      this.seating = {
        ...seating,
        phase: "lower",
        t: 0,
        duration: SITTING.sitTime,
        from: at,
        to: seatFloorPoint(seating.seat),
      };
    } else if (seating.phase === "lower") {
      this.seating = { ...seating, phase: "seated", from: at, to: at };
    } else if (seating.phase === "rise") {
      this.leaveSeat();
    }
  }

  /** Back to walking where you are, physics on. */
  private leaveSeat() {
    const s = this.state;
    this.seating = null;
    this.collider.setEnabled(true);
    const c = this.centerFromFeet(s.position);
    this.body.setTranslation(c, true);
    this.body.setNextKinematicTranslation(c);
    s.velocity = [0, 0, 0];
    s.speed = 0;
    s.loco = LocoState.idle;
    s.sitAmount = 0;
    delete s.seatId;
  }

  dispose() {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeRigidBody(this.body);
  }

  private centerFromFeet(p: Vec3) {
    return { x: p[0], y: p[1] + this.halfHeight, z: p[2] };
  }
}
