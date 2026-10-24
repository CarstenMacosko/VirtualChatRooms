import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildAvatarVrm, GENERATOR_VERSION } from "@vcr/avatar";
import {
  ANIMATED_BONES,
  type AnimatorInput,
  type ExpressionWeights,
  FaceAnimator,
  type FaceInput,
  ProceduralAnimator,
  VRM_EXPRESSIONS,
  type Vec3,
} from "@vcr/engine";
import type { AvatarRecipe, EmoteId } from "@vcr/protocol";

/** Layer avatars render on as well as 0, so headshot cameras can draw just the avatars. */
export const AVATAR_LAYER = 1;

const builtCache = new Map<string, Uint8Array>();

/** Builds each distinct recipe once; every instance parses its own copy of the scene graph. */
function vrmBytes(recipe: AvatarRecipe): Uint8Array {
  const key = `${GENERATOR_VERSION}:${JSON.stringify(recipe)}`;
  let bytes = builtCache.get(key);
  if (!bytes) {
    bytes = buildAvatarVrm(recipe);
    if (builtCache.size > 64) builtCache.delete(builtCache.keys().next().value!);
    builtCache.set(key, bytes);
  }
  return bytes;
}

export async function loadAvatarVrm(recipe: AvatarRecipe): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(vrmBytes(recipe).slice().buffer, "");
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false; // skinned bounds don't follow animation
    o.layers.enable(AVATAR_LAYER);
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

export interface AvatarFrame extends AnimatorInput {
  position: Vec3;
  yaw: number;
}

/**
 * One avatar in the scene, built from its recipe: posed each frame by the engine's
 * ProceduralAnimator (locomotion + emotes), with a face driven by FaceAnimator (webcam tracking,
 * voice, or procedural blinks). Used for local and remote people, and the creator preview.
 */
export class AvatarInstance {
  readonly root = new Group();
  private vrm: VRM | null = null;
  private recipeKey = "";
  private loading = 0;
  private readonly animator = new ProceduralAnimator();
  private readonly face = new FaceAnimator();
  private faceInput: FaceInput = {};
  private mood: Partial<ExpressionWeights> = {};
  private restHipsY = 0;
  private disposed = false;
  private headVisible = true;

  constructor(recipe: AvatarRecipe, options: { shadow?: boolean } = {}) {
    if (options.shadow !== false) this.root.add(blobShadow());
    this.setRecipe(recipe);
  }

  /** Swaps in a different look (someone edited their avatar); keeps animation state. */
  setRecipe(recipe: AvatarRecipe) {
    const key = JSON.stringify(recipe);
    if (key === this.recipeKey) return;
    this.recipeKey = key;
    const ticket = ++this.loading;
    loadAvatarVrm(recipe)
      .then((vrm) => {
        if (this.disposed || ticket !== this.loading) {
          VRMUtils.deepDispose(vrm.scene);
          return;
        }
        if (this.vrm) {
          this.vrm.scene.removeFromParent();
          VRMUtils.deepDispose(this.vrm.scene);
        }
        this.vrm = vrm;
        this.restHipsY = vrm.humanoid.getNormalizedBoneNode("hips")?.position.y ?? 0;
        this.setHeadVisible(this.headVisible);
        this.root.add(vrm.scene);
      })
      .catch((err: unknown) => console.error(err));
  }

  get loaded() {
    return this.vrm !== null;
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

  /** Runs `fn` with the head shown, e.g. to render a headshot of your own first-person avatar. */
  withHeadShown(fn: () => void) {
    const hidden = !this.headVisible;
    if (hidden) this.setHeadVisible(true);
    fn();
    if (hidden) this.setHeadVisible(false);
  }

  /** Face inputs for the coming frames: tracked blendshapes and/or voice loudness. */
  setFace(input: Omit<FaceInput, "mood">) {
    this.faceInput = input;
  }

  /** Holds expressions on the face (the creator's "try an expression" buttons). */
  setMood(mood: Partial<ExpressionWeights>) {
    this.mood = mood;
  }

  playEmote(id: EmoteId) {
    this.animator.playEmote(id);
  }

  /** World position of the middle of the face, for headshots and look-at. */
  faceWorldPosition(target: Vector3): boolean {
    const head = this.vrm?.humanoid.getRawBoneNode("head");
    if (!head) return false;
    head.getWorldPosition(target);
    target.y += 0.17 * this.root.scale.y;
    return true;
  }

  update(dt: number, frame: AvatarFrame) {
    this.root.position.set(...frame.position);
    this.root.rotation.y = frame.yaw;
    const vrm = this.vrm;
    if (!vrm) return;

    // The seated pose needs the hips' rest height to lower them onto the seat.
    const pose = this.animator.update(dt, { hipsHeight: this.restHipsY || undefined, ...frame });
    for (const name of ANIMATED_BONES) {
      vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(...pose.bones[name]);
    }
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    if (hips) hips.position.y = this.restHipsY + pose.hipsOffsetY;

    const expressions = this.face.update(dt, {
      ...this.faceInput,
      mood: { ...this.mood, ...pose.mood },
    });
    const manager = vrm.expressionManager;
    if (manager) for (const name of VRM_EXPRESSIONS) manager.setValue(name, expressions[name]);
    vrm.update(dt);
  }

  dispose() {
    this.disposed = true;
    this.root.removeFromParent();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
  }
}
