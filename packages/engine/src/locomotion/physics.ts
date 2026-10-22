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

  addBox({ center, halfExtents }: BoxCollider) {
    const desc = RAPIER.ColliderDesc.cuboid(...halfExtents).setTranslation(...center);
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

  step() {
    this.world.step();
    this.queriesStale = false;
  }

  dispose() {
    this.world.free();
  }
}
