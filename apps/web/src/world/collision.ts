import type { BufferGeometry, Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  type Aabb,
  aabbToCollider,
  collisionBoxes,
  collisionToWorld,
  dropWalkwayTriangles,
  passableWalkways,
  type PhysicsWorld,
  walkwayColliders,
} from "@vcr/engine";
import type { SceneAssets, Walkway } from "@vcr/protocol";
import { assetUrl } from "../lib/api";

/** A scan's collision mesh in world space: its triangles, and its boxes when it is made of them. */
export interface RoomCollision {
  meshes: Array<{ vertices: Float32Array; indices: Uint32Array }>;
  /** World AABBs when every mesh is post-processing's boxes (8 vertices, 36 indices each). */
  boxes: Aabb[] | null;
}

/** Loads a scan's collision GLB (file space) and moves it into the world by the manifest transform. */
export async function loadRoomCollision(scene: SceneAssets): Promise<RoomCollision> {
  const { manifest, urls } = scene;
  const url = urls[manifest.collision.key];
  if (!url) throw new Error("the room's collision mesh is missing");
  const gltf = await new GLTFLoader().loadAsync(assetUrl(url));
  gltf.scene.updateMatrixWorld(true);
  const meshes: RoomCollision["meshes"] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as Mesh<BufferGeometry>;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const position = geometry.getAttribute("position");
    const vertices = collisionToWorld(new Float32Array(position.array), manifest.transform);
    const index = geometry.getIndex();
    const indices = index
      ? Uint32Array.from(index.array)
      : Uint32Array.from({ length: position.count }, (_, i) => i);
    meshes.push({ vertices, indices });
  });
  if (!meshes.length) throw new Error("the room's collision mesh is empty");
  const perMesh = meshes.map((m) => collisionBoxes(m.vertices, m.indices));
  const boxes = perMesh.every((b) => b !== null) ? perMesh.flat() : null;
  return { meshes, boxes };
}

/**
 * Adds the room's colliders with walkways opened up wide enough to walk through: when the mesh is
 * boxes, clipped boxes with walls put back along the walkways' edges; otherwise the triangles,
 * minus those inside a walkway.
 */
export function addRoomColliders(
  physics: PhysicsWorld,
  collision: RoomCollision,
  walkways: readonly Walkway[],
) {
  if (collision.boxes) {
    for (const box of walkwayColliders(collision.boxes, walkways)) {
      physics.addBox(aabbToCollider(box));
    }
    return;
  }
  const open = passableWalkways(walkways);
  for (const m of collision.meshes) {
    const indices = dropWalkwayTriangles(m.vertices, m.indices, open);
    if (indices.length) physics.addTrimesh(m.vertices, indices);
  }
}
