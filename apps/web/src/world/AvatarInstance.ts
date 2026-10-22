import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  CanvasTexture,
  Color,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ANIMATED_BONES, ProceduralAnimator, type Vec3 } from "@vcr/engine";
import type { LocoState } from "@vcr/protocol";

export const PLACEHOLDER_AVATAR_URL = "/avatars/placeholder.vrm";

const fileCache = new Map<string, Promise<ArrayBuffer>>();

/** Fetches each VRM file once; every avatar instance parses its own copy of the scene graph. */
async function loadVrm(url: string): Promise<VRM> {
  let file = fileCache.get(url);
  if (!file) {
    file = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Avatar ${url} failed to load (${r.status})`);
      return r.arrayBuffer();
    });
    fileCache.set(url, file);
  }
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(await file, "");
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false; // skinned bounds don't follow animation
  });
  return vrm;
}

let shadowTexture: CanvasTexture | null = null;
function blobShadow(): Mesh {
  if (!shadowTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(0,0,0,0.45)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    shadowTexture = new CanvasTexture(canvas);
  }
  const mesh = new Mesh(
    new PlaneGeometry(0.9, 0.9),
    new MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.renderOrder = 1;
  return mesh;
}

export interface AvatarFrame {
  position: Vec3;
  yaw: number;
  loco: LocoState;
  speed: number;
  lookPitch?: number;
}

/**
 * One avatar in the scene: loads a VRM, tints its clothes, and poses it each frame from
 * locomotion state using the engine's ProceduralAnimator. Used for both local and remote people.
 */
export class AvatarInstance {
  readonly root = new Group();
  private vrm: VRM | null = null;
  private readonly animator = new ProceduralAnimator();
  private restHipsY = 0;
  private disposed = false;
  private headVisible = true;

  constructor(url: string, color: string) {
    this.root.add(blobShadow());
    loadVrm(url)
      .then((vrm) => {
        if (this.disposed) {
          VRMUtils.deepDispose(vrm.scene);
          return;
        }
        this.vrm = vrm;
        this.restHipsY = vrm.humanoid.getNormalizedBoneNode("hips")?.position.y ?? 0;
        tintClothes(vrm.scene, color);
        this.setHeadVisible(this.headVisible);
        this.root.add(vrm.scene);
      })
      .catch((err: unknown) => console.error(err));
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** First person hides your own head so it doesn't block the view. */
  setHeadVisible(visible: boolean) {
    this.headVisible = visible;
    const head = this.vrm?.humanoid.getRawBoneNode("head");
    if (head) head.scale.setScalar(visible ? 1 : 0.0001);
  }

  update(dt: number, frame: AvatarFrame) {
    this.root.position.set(...frame.position);
    this.root.rotation.y = frame.yaw;
    const vrm = this.vrm;
    if (!vrm) return;

    const pose = this.animator.update(dt, frame);
    for (const name of ANIMATED_BONES) {
      vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(...pose.bones[name]);
    }
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    if (hips) hips.position.y = this.restHipsY + pose.hipsOffsetY;
    vrm.update(dt);
  }

  dispose() {
    this.disposed = true;
    this.root.removeFromParent();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
  }
}

function tintClothes(scene: Object3D, color: string) {
  const tint = new Color(color);
  scene.traverse((o) => {
    const material = (o as Mesh).material as Material | Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      if (m.name === "Clothes") (m as MeshStandardMaterial).color.copy(tint);
    }
  });
}
