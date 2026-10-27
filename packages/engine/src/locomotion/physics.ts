import * as RAPIER from "@dimforge/rapier3d-compat";
import type { Vec3 } from "../math";

let ready: Promise<void> | null = null;

/** Loads Rapier's WASM once per page (or test process). */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export type Rapier = typeof RAPIER;

export interface BoxCollider {
  center: Vec3;
  halfExtents: Vec3;
  /** Turned about +Y (radians), like a table's yaw; axis-aligned when absent. */
  yaw?: number;
}

/** Static room geometry plus the queries the character and camera need. */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private queriesStale = false;

  private constructor() {
    // Gravity is applied by the character controller itself; the world has no dynamic bodies yet.
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  }

  static async create(): Promise<PhysicsWorld> {
    await initPhysics();
    return new PhysicsWorld();
  }

  get rapier(): Rapier {
    return RAPIER;
  }

  addBox({ center, halfExtents, yaw = 0 }: BoxCollider) {
    const desc = RAPIER.ColliderDesc.cuboid(...halfExtents)
      .setTranslation(...center)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    this.queriesStale = true;
    return this.world.createCollider(desc);
  }

  /** For scanned rooms: the collision mesh from the room manifest. */
  addTrimesh(vertices: Float32Array, indices: Uint32Array) {
    this.queriesStale = true;
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
  }

  /** Distance to the first static hit along `dir` (normalized), or null within `maxDistance`. */
  castRay(origin: Vec3, dir: Vec3, maxDistance: number, exclude?: RAPIER.Collider): number | null {
    // Rapier only sees new colliders in queries after a step.
    if (this.queriesStale) this.step();
    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = this.world.castRay(ray, maxDistance, true, undefined, undefined, exclude);
    return hit ? hit.timeOfImpact : null;
  }

  /**
   * Whether an upright capsule (`radius`, total `height`) standing at `feet` is clear of the room
   * and has floor under it (within `drop`).
   */
  capsuleFits(
    feet: Vec3,
    radius: number,
    height: number,
    exclude?: RAPIER.Collider,
    drop = 0.35,
  ): boolean {
    if (this.queriesStale) this.step();
    // A hair above the floor, so touching it isn't overlapping it.
    const center = { x: feet[0], y: feet[1] + height / 2 + 0.03, z: feet[2] };
    const shape = new RAPIER.Capsule(height / 2 - radius, radius);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const blocked = this.world.intersectionWithShape(
      center,
      rotation,
      shape,
      undefined,
      undefined,
      exclude,
    );
    if (blocked) return false;
    return (
      this.castRay([feet[0], feet[1] + 0.3, feet[2]], [0, -1, 0], 0.3 + drop, exclude) !== null
    );
  }

  step() {
    this.world.step();
    this.queriesStale = false;
  }

  dispose() {
    this.world.free();
  }
}
